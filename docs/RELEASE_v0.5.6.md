# DB EX v0.5.6 (Preview)

- Remove the fixed Development / Testing / Production connection selector and badges throughout the application, including stored configuration and new backups.
- Use unrestricted connection group names and optional colors instead; existing group names and custom colors are preserved.
- Read older profiles and backups without requiring or validating their obsolete environment field. Credentials and connection identity are retained.
- Preserve read-only-by-default, explicit write unlock and per-write native confirmation for every connection. Confirmation shows the target connection and address.
- Keep v0.5.5 BSON type colors, extended color palette and all 14 UI languages.
