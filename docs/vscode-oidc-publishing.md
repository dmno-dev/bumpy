# Publishing a VS Code extension with OIDC (no PAT)

The usual way to publish a VS Code extension from CI is with a `VSCE_PAT` — a long-lived Azure DevOps Personal Access Token. PATs **expire** (max 1 year, often less), and when they do your release silently fails. This guide replaces the PAT with **Microsoft Entra workload identity federation (OIDC)**: CI mints a short-lived token at publish time, so there's nothing to rotate.

bumpy doesn't publish extensions itself — you point it at `vsce` via a [custom `publishCommand`](./configuration.md#example-custom-publish-for-a-vscode-extension). This guide covers the awkward one-time setup around that: the Azure identity, the not-obvious Marketplace permission step, and the CI wiring.

> **Open VSX is separate.** Azure OIDC only covers the Microsoft VS Code Marketplace (`vsce`). Open VSX (`ovsx`) is a different registry and still uses an access token — see [Open VSX](#open-vsx) at the end.

## How the pieces fit together

```
GitHub Actions job
  └─ azure/login (OIDC)            ← exchanges GitHub's OIDC token for an Entra token
       └─ bumpy ci release
            └─ publishCommand: vsce publish --azure-credential
                 └─ @azure/identity picks up the az CLI session → publishes
```

`vsce publish --azure-credential` authenticates via `@azure/identity`'s `DefaultAzureCredential`, which picks up the session established by `azure/login`. bumpy runs your `publishCommand` in a child process that **inherits the job environment and the `az` CLI session**, so a single `azure/login` step before `bumpy ci release` is all the wiring bumpy needs.

## Prerequisites

- **Your Marketplace publisher must be backed by a Microsoft Entra (Azure AD) organization tenant**, and you must sign in to the Marketplace as a **member** (not a guest) account in that tenant. A publisher owned by a _personal_ Microsoft account (`@outlook`, `@gmail`, …) **cannot** use a managed identity or service principal — there's no tenant to host it. If that's your situation, OIDC isn't available without first moving the publisher to an org tenant. (See [Troubleshooting](#troubleshooting).)
- The [`az` CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and [`gh` CLI](https://cli.github.com/), logged in.
- An existing Marketplace publisher (the `publisher` field in your extension's `package.json`).

Set a couple of shell variables used throughout:

```bash
REPO="your-org/your-repo"          # the GitHub repo that runs the release
APP_NAME="my-ext-marketplace-ci"   # any name for the Entra app registration
```

## Step 1 — Create an Entra app registration with a GitHub federated credential

We use an **app registration** (service principal) rather than a user-assigned managed identity. Both can federate with GitHub, but a managed identity can't be authenticated _from your laptop_, which you need for the Marketplace permission step below. The app-registration path is scriptable end-to-end.

```bash
# create the app + service principal
az ad app create --display-name "$APP_NAME"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
az ad sp create --id "$APP_ID"
TENANT_ID=$(az account show --query tenantId -o tsv)

echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$TENANT_ID"

# trust GitHub Actions OIDC tokens from this repo's main branch
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-release-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:'"$REPO"':ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

The `subject` must match how the workflow runs. For a job that runs on push to `main`, use `repo:<org>/<repo>:ref:refs/heads/main`. If you gate publishing behind a [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments), use `repo:<org>/<repo>:environment:<name>` instead and add `environment:` to the job.

## Step 2 — Grant the app access to your Marketplace publisher

This is the part that trips everyone up. The publisher **Members** UI does **not** accept the app's Client ID, Object ID, or ARM resource ID. It wants the app's **Team Foundation Identity ID** — an Azure-DevOps-internal GUID you can only get by authenticating _as the app_ and calling the profile API.

```bash
# temporarily give the app a client secret so we can sign in as it
SECRET=$(az ad app credential reset --id "$APP_ID" --query password -o tsv)

# sign in as the service principal
az login --service-principal -u "$APP_ID" -p "$SECRET" --tenant "$TENANT_ID" --allow-no-subscriptions

# 499b84ac-1321-427f-aa17-267ca6975798 is the fixed Azure DevOps resource id
TOKEN=$(az account get-access-token \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --query accessToken -o tsv)

# the "id" in the response is the Team Foundation Identity ID
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.3"

# switch back to your own account afterwards
az login
```

Copy the `id` from the JSON response. Then:

1. Open the Marketplace publisher management page: `https://marketplace.visualstudio.com/manage/publishers/<your-publisher>` (sign in with your org account that owns the publisher).
2. In **Members**, add a new member, paste the **Team Foundation Identity ID**, and assign the **Contributor** role.

Clean up the temporary secret once the member is added — publishing uses OIDC, not the secret:

```bash
az ad app credential list --id "$APP_ID" --query "[].keyId" -o tsv
az ad app credential delete --id "$APP_ID" --key-id <keyId-from-above>
```

## Step 3 — Add the identity to GitHub

The workflow needs the app's client and tenant ids. Neither is secret (they're identifiers), but storing them as repo secrets keeps the workflow uniform:

```bash
gh secret set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
gh secret set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT_ID"
```

You no longer need a `VSCE_PAT` secret — delete it once OIDC is confirmed working.

## Step 4 — Point bumpy's publishCommand at `--azure-credential`

In `.bumpy/_config.json`:

```json
{
  "packages": {
    "my-vscode-extension": {
      "skipNpmPublish": true,
      "buildCommand": "vsce package -o extension.vsix",
      "publishCommand": "vsce publish -i extension.vsix --azure-credential"
    }
  }
}
```

The `--azure-credential` flag is what swaps PAT auth for `@azure/identity`. Pre-packaging the `.vsix` in `buildCommand` and publishing it with `-i` keeps `vsce` from rebuilding during publish — optional but recommended.

## Step 5 — Add `azure/login` to the release workflow

Add an OIDC login step **before** `bumpy ci release`. The job needs `id-token: write`.

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write # required for OIDC
    steps:
      - uses: actions/checkout@v6
      # ... setup + install ...

      - name: Azure login (OIDC) for Marketplace publishing
        uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - name: Publish
        run: bunx @varlock/bumpy ci release
        env:
          GH_TOKEN: ${{ github.token }}
          # no VSCE_PAT needed — vsce uses the az session from the step above
```

`allow-no-subscriptions: true` is needed because the app has no Azure subscription role — it only needs a token for the Marketplace.

### Only log in when actually publishing

`azure/login` will fail the job if the federated credential is misconfigured, so you don't want it running on releases that don't touch the extension. If your release workflow has a planning step, gate the login on it. For example, with `bumpy ci plan`:

```yaml
plan:
  runs-on: ubuntu-latest
  outputs:
    includes-ext: ${{ contains(fromJSON(steps.plan.outputs.json).packageNames, 'my-vscode-extension') }}
  steps:
    - uses: actions/checkout@v6
    - uses: oven-sh/setup-bun@v2
    - id: plan
      run: bunx @varlock/bumpy ci plan
      env:
        GH_TOKEN: ${{ github.token }}

release:
  needs: plan
  steps:
    # ...
    - name: Azure login (OIDC) for Marketplace publishing
      if: needs.plan.outputs.includes-ext == 'true'
      uses: azure/login@v2
      with:
        client-id: ${{ secrets.AZURE_CLIENT_ID }}
        tenant-id: ${{ secrets.AZURE_TENANT_ID }}
        allow-no-subscriptions: true
```

## Open VSX

Open VSX (`ovsx`) is run by the Eclipse Foundation and is **not** covered by Azure OIDC — it still uses an access token. Keep publishing to it as a second command, with the token from a secret:

```json
{
  "packages": {
    "my-vscode-extension": {
      "skipNpmPublish": true,
      "buildCommand": "vsce package -o extension.vsix",
      "publishCommand": "vsce publish -i extension.vsix --azure-credential && ovsx publish -i extension.vsix"
    }
  }
}
```

```yaml
- name: Publish
  run: bunx @varlock/bumpy ci release
  env:
    GH_TOKEN: ${{ github.token }}
    OVSX_PAT: ${{ secrets.OVSX_PAT }}
```

(If you also manage secrets with [varlock](https://varlock.dev), you can source `OVSX_PAT` — and the `AZURE_*` ids — from a vault instead of GitHub secrets, but that's outside bumpy's scope.)

## Troubleshooting

**The publisher Members box won't accept my id.** You're almost certainly pasting the Client ID, Object ID, or ARM resource ID. It only accepts the **Team Foundation Identity ID** from the profile API call in [Step 2](#step-2--grant-the-app-access-to-your-marketplace-publisher). Tip: add the member as **Reader** first and confirm the display name resolves before switching it to **Contributor**.

**`AADSTS5000225: tenant has been blocked due to inactivity`** (or you see several auto-named _"Default Directory"_ tenants). These are throwaway tenants Azure auto-creates for personal/lightly-used accounts. If your app registration lives in one of them, it can get blocked and break publishing without warning. Make sure the app lives in a real, actively-used org tenant — not an auto-created `Default Directory`.

**The publisher is owned by a personal Microsoft account.** A managed identity / service principal can't be added to it — there's no Entra org tenant to host the identity. You'll need to move/recreate the publisher under an org tenant, or keep using a PAT.

**The publish fails but the error is unhelpful.** Custom `publishCommand` output is captured by the runner; if the cause is unclear, reproduce locally — `az login` as yourself (a publisher Contributor) and run `vsce publish --azure-credential` directly to see `vsce`'s full error.

## See also

- [Configuration reference](./configuration.md#example-custom-publish-for-a-vscode-extension) — `publishCommand` / `buildCommand` / `skipNpmPublish`
- [GitHub Actions setup](./github-actions.md) — the surrounding release workflow
- [VS Code docs: secure publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
