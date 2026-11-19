# Data compatibility

Rules for changing the shape of data that one version of the app writes and another version reads.
Read this before adding, renaming or removing a field on a Rust type that derives `Deserialize`, or
before adding a value to an enum.

## Where data crosses versions

| Data | Written by | Read by | Types |
| --- | --- | --- | --- |
| Pairing payload (link code and air-gap) | The sending device | The receiving device, which may run an older or newer version | `SyncPayload` and everything in it (`pairing/payload/mod.rs`): `Account`, `UsageSnapshot`, `UsageWindow`, `LimitReset`, `AccountBucket`, `ProviderSecret`, `UsageAlertSetting` |
| Stored JSON files in the data folder | This device | The next version after an update, or an older one after a downgrade or a switch off the beta channel | `JsonFileStore` users in `store/` |
| Saved sign-ins (keychain, Keystore, credential files) | This device | Same as stored files | `ProviderSecret` |
| Local API (`/v1/paseo-usage`, `schemaVersion: 1`) | This app | Other programs | `PublicUsageResponse`, `PublicUsageAccount`, `BridgeUsageWindow` (`model.rs`) |
| Frontend IPC | The Rust backend | The WebView of the same build | Anything a command returns or an event carries |

Frontend IPC never crosses versions (the WebView ships in the same bundle), so it only has to match
the TypeScript types, which are generated from the Rust types (`src/types.generated.ts`, see `type_contract.rs`). Everything else follows the rules below.

## What happens to an unknown or missing field

- **A field the reader does not know is ignored.** None of these types uses
  `#[serde(deny_unknown_fields)]`, and none may. `payload_fields_from_a_newer_peer_are_ignored`
  (`pairing/tests.rs`) adds an unknown field to every object in a full payload and checks that it
  still parses with nothing lost.
- **A field the reader expects but the data lacks fails the whole read** unless the field has a
  default. For a pairing payload the transfer is refused; for a stored file the app does not start
  (`JsonFileStore::open` reports it as a startup issue).
- **An enum value the reader does not know also fails the whole read**, even inside a field that
  has a default. A new `Provider`, `WindowKind` or `UsageFreshness` value sent to an older peer
  refuses the payload, and written to a file it stops an older version from starting.
  `an_unknown_enum_value_from_a_newer_peer_refuses_the_payload` pins this.

## Rules

1. **Add fields; do not rename or remove them.** Every new field on a type that is deserialized
   gets `#[serde(default)]`, or `#[serde(default = "function")]` when the safe value is not the
   type's `Default`. Write it on `Option` fields too, even though serde would treat a missing
   `Option` as `None` without it, so the intent is visible.
2. **Missing must mean "behave as before".** Choose the default so data from an older version keeps
   its old meaning: `LimitReset::usable` defaults to `true` because grants saved before the field
   existed could all be used.
3. **Leave a field out when it has no value** only when older readers have a default for it
   (`#[serde(default, skip_serializing_if = "Option::is_none")]`). Never stop sending a field that a
   released version reads without a default (for example `Account::auth_required`): older receivers
   would refuse every payload.
4. **Do not add values to an enum that peers or files carry** without a fallback that every reader
   in use already has. A fallback is a unit variant marked `#[serde(other)]`, and it only helps
   readers released after it, so it has to ship (at least one release) before the first new value
   is written. Until then, keep the new value out of stored files and payloads.
   Adding a provider is the known exception: a new `Provider` value is unavoidable, so an older
   peer refuses any payload that holds an account of the new provider (both devices need the
   update). Stored files are unaffected unless the user downgrades.
5. **Values the backend derives are not read back.** A field that Rust computes from other data
   (for example account health or a plan display name) is marked `#[serde(default,
   skip_deserializing)]` and recomputed after loading and after a pairing import, so a peer cannot
   set it and a stale stored value is never trusted. Older readers ignore it as an unknown field, so
   its enum may gain values freely. Prefer keeping such fields off the stored and paired types
   altogether when a separate IPC type is practical.
6. **Changes that cannot be additive are migrations.** Rewriting stored values (a renamed provider,
   a changed label) goes in `migrations.rs`: run on every start, idempotent, retried on failure.
   Apply the same rewrite to accounts that arrive by pairing, since the sender may still hold the
   old form. Test it on copies of real old files.
7. **The local API is its own set of types.** Fields reach it only through
   `bridge_api::public_accounts`, so a field added to `Account` or `UsageWindow` does not appear
   there by accident. Changes there are additive only; anything else needs a `schemaVersion` bump
   and a product decision (see `AGENTS.md`).

## Checklist for a new field on a paired or stored type

- [ ] `#[serde(default)]` (or a default function) chosen so missing means the old behaviour
- [ ] The field is filled in `full_sync_payload` in `pairing/tests.rs` if the type is in the payload,
      and listed in `payload_from_an_older_peer_without_newer_fields_parses`
- [ ] If the field is derived: `skip_deserializing` and recomputed on load and import
- [ ] If the type is sent to the frontend: `src/types.generated.ts` and the `type_contract.rs` samples regenerated (`UPDATE_FIXTURES=1`)
- [ ] No new enum value written to files or payloads (rule 4)
