# Signing Aurora

Every Aurora release must be signed with the same private key, or Android refuses to install it over the app that
is already on a phone or TV. That key and its password are **secrets and are never committed to this repository**
(`*.keystore`, `*.jks` and `keystore.properties` are ignored by git).

## Where the key lives

- **GitHub builds:** two repository secrets, set at *Settings → Secrets and variables → Actions → New repository secret*:
  - `AURORA_KEYSTORE_BASE64`: the whole text of `KEYSTORE_BASE64.txt` (the keystore file as one line of Base64)
  - `AURORA_KEYSTORE_PASSWORD`: the keystore password (the key uses the same one). The key alias is `aurora`.
  The workflow stops with a clear message if either is missing; it never falls back to another key.
- **Your backup:** keep `aurora-release.keystore` and its password in a password manager or other safe place that is
  not this repository. **If you lose them you can never update installed copies again.**
- **Building on your own computer (optional):** put the keystore somewhere outside the repo and create
  `android/keystore.properties` (ignored by git):

  ```
  storeFile=/full/path/to/aurora-release.keystore
  storePassword=...the password...
  keyAlias=aurora
  ```

  then `cd android && gradle assembleRelease`. Debug builds use Android's own debug key and need nothing.

## If the key is ever exposed

Treat it as compromised: generate a new one (`keytool -genkeypair -v -keystore aurora-release.keystore -storetype PKCS12
-alias aurora -keyalg RSA -keysize 4096 -validity 10950`), replace both secrets, and expect every installed copy to need
a one-time uninstall and reinstall, because Android will not accept an update signed with a different key.
