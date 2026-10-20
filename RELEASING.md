# Releasing Aurora: stable and beta

Every push that changes `aurora/`, `android/` or the build workflow builds the app and publishes a GitHub release.
Each device chooses its channel in **Settings → About → Update channel**:

- **Stable** (the default): only offered normal releases.
- **Beta**: also offered pre-releases, so it gets new versions first.

## How a release becomes beta or stable

| You want | Do this |
|---|---|
| A **stable** release (what happens today) | Push as usual. |
| A **beta** release | Put `[beta]` anywhere in the last commit message of the push. The release is published as a *pre-release*, named "Aurora 1.2.N (beta)", and is not marked "latest". Stable devices never see it. |
| **Promote** a beta to stable | On GitHub: Releases → open the beta release → Edit (pencil) → remove " (beta)" from the title, untick **Set as a pre-release**, tick **Set as the latest release** → **Update release**. Stable devices are then offered it. (The workflow also has a `promote_tag` input that does the same without clicking, but GitHub only offers "Run workflow" for workflows that exist on the repository's default branch, and this one lives on the working branch until it is merged to main.) |
| A manual build as beta | Run the workflow by hand and set `build_channel` to `beta`. |

Version numbers are one sequence shared by both channels (`aurora-v1.2.N`), so a device on Beta that is ahead of Stable simply
stays on its version until the next stable one is newer; there is no downgrade.

Devices on versions older than this feature always follow stable only (they ignore pre-releases), so switching a release
to beta never reaches them.

Reinstall note: the first release signed with the new key (see `android/SIGNING.md`) needs a one-time uninstall and reinstall.
