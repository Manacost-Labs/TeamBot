# Google Workspace

One Google Workspace connector gives governed access to Google Drive, Google Docs and Google
Sheets. Every request runs with the OAuth grant of the person who asked, not with an administrator's
account or a shared service account. Access and refresh tokens stay on the server and are never added
to prompts, tool results, chat history or audit metadata.

The connector uses Google's generally available REST APIs:

- Google Drive API v3;
- Google Docs API v1;
- Google Sheets API v4.

It does not depend on the Google Workspace MCP Developer Preview.

## Production values for this deployment

Create an OAuth client of type **Web application**. In Google Cloud enter:

| Google Cloud field | Value |
| --- | --- |
| Authorized JavaScript origin | `https://work-origin.kolodahearthstone.com` |
| Authorized redirect URI | `https://work-origin.kolodahearthstone.com/api/plugins/oauth/callback` |

The OAuth exchange is handled by the server, so the JavaScript origin is not part of the token
exchange. It is still safe to register the production origin for browser-facing Google features.
The redirect URI is required and must match exactly, including scheme, hostname, path and the absence
of a trailing slash.

Do not put the client ID or client secret in this repository or an `.env` file. Enter both at
`/admin/plugins/google-drive` in the **OAuth client** dialog. The client secret is encrypted with
`KEY_ENCRYPTION_KEY` and is never returned to the browser after saving.

## Google Cloud setup

### 1. Enable the APIs

Enable all three APIs in the same Google Cloud project as the OAuth client:

- `drive.googleapis.com` — Google Drive API;
- `docs.googleapis.com` — Google Docs API;
- `sheets.googleapis.com` — Google Sheets API.

The connector calls these fixed Google hosts directly. Enabling a Workspace MCP API or enrolling in
the Workspace Developer Preview Program is not required.

### 2. Configure the consent screen

Configure the app name, support email, audience and developer contact information. Add these exact
scopes under **Data Access**:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
```

`drive.readonly` lets a user search and read files they can already access. `drive.file` allows the
connector to manage only files it created or that the person explicitly opened with it. The Docs
and Sheets scopes enable the explicit document and spreadsheet tools; the connector does not
request unrestricted Drive write access.

For an **External** app in Testing, add every account that will connect as a test user. Testing grants
can expire, and Google limits unverified test usage. Before a public launch, complete the verification
Google requires for the requested sensitive or restricted scopes. An Internal app can be used only
by accounts in its Google Workspace organization.

Official references:

- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Docs scopes](https://developers.google.com/workspace/docs/api/auth)
- [Google Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes)

### 3. Create the OAuth client

Choose **Web application**, paste the production origin and redirect URI from the table above, then
create the client. Keep the client secret outside source control. If Google shows the secret only
once, copy it directly into the OpenBot administrator dialog or an approved secret manager.

### 4. Enable the connector

At `/admin/plugins/google-drive`:

1. Switch on **Enable for this deployment**.
2. Open **OAuth client** and enter the client ID and client secret.
3. Press **Refresh tools**.
4. Grant only the required read or write tools to each Bot.

The plugin page displays the redirect URI generated from `OPENBOT_PUBLIC_URL`. Always use that value
if it differs from this document.

### 5. Connect each person's account

At `/settings/connected-accounts/google-drive`, press **Connect**. Google shows the requested scopes
and returns the browser to OpenBot. The saved refresh token belongs only to that user. A Bot call must
still pass all of these boundaries:

1. the user granted the required Google scope;
2. the Bot was granted that exact tool;
3. the action policy permits the call;
4. the call is written to the audit trail.

An administrator cannot connect an account on somebody else's behalf.

People who connected before `drive.file` was added must choose **Reconnect or update access** on the
connected-account page before using upload, folder creation or move tools. Existing read-only grants
are not silently widened.

## Tool groups

Drive tools search by filename, content keywords, MIME type, modification time and folder, then read
only the selected file. The governed file bridge can import one supported Drive file into the
current conversation, upload one attachment from that exact conversation, create a folder and move
a file only when its current parent set still matches the caller's expectation. Imports become
private `google_export` attachments; uploads and folder creation carry deterministic operation
metadata so an ambiguous response can be recovered without blindly repeating a write.

Docs tools read structured document content and provide bounded create, append and
compare-before-replace operations. Sheets tools use bounded A1 ranges and rectangular row sets for
reads, creates, appends, updates and clears.

Google writes are classified as external side effects. Broad clears require explicit confirmation;
Docs replacements verify the expected text and revision; ambiguous append failures say not to retry
automatically so a network timeout cannot silently duplicate content.

## Troubleshooting

### `redirect_uri_mismatch`

Compare the redirect URI shown in OpenBot with the OAuth client's **Authorized redirect URIs**. It
must match character for character. Common errors are a trailing slash, `http` instead of `https`,
the wrong subdomain, or registering the value on another OAuth client.

### Access denied during testing

For an External app in Testing, add the Google account under **Audience → Test users**. Also verify
that the four requested scopes are present under **Data Access**.

### `401` or the connection stops working

Reconnect the person's account. OpenBot requests offline access and requires a refresh token; a
revoked or expired grant is never replaced by an administrator's credential.

### `403` or insufficient scopes

Verify that Drive, Docs and Sheets APIs are enabled in the OAuth client's project and that the user
granted the scope required by the attempted tool. Adding new scopes requires reconnecting so Google
can issue a grant that includes them.

### A Bot has no Google tools

Enabling the connector and connecting an account do not grant a Bot capabilities. Refresh the tool
list and grant the required tools to that Bot at `/admin/plugins/google-drive`. A read grant does not
imply a write grant.

### Audit interpretation

- `mcp.call_rejected`: an OpenBot grant or policy boundary refused the call;
- `mcp.call_failed`: Google or the network refused a permitted call;
- `mcp.call_succeeded`: Google accepted and completed the operation.

Audit records contain operation metadata and identifiers, not OAuth tokens or document/cell content.

## See also

- [Architecture](../architecture.md)
- [Configuration](../configuration.md)
- [Google OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
