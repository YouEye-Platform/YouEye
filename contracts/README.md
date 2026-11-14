# Contracts between components

Fixtures that two components read with their own code, so a change on one side fails the other side's tests.
Each fixture is written by the producer's test and parsed by the consumer's test.

| Fixture | Producer (writes it) | Consumer (parses it) |
|---|---|---|
| `spine-cp/status-appliance.json` | Spine `GET /api/status` types (`spine/internal/api/backup_contract_test.go`) | CP backup identity (`control-panel/tests/spine-contract.spec.ts`) |
| `spine-cp/backup-store-request.json` | CP `backupStoreRequest` (`control-panel/tests/spine-contract.spec.ts`) | Spine strict decoder (`spine/internal/backup/contract_test.go`) |

After an intended change, regenerate with `YOUEYE_UPDATE_CONTRACTS=1` on the producer's test, then run the
consumer's test. Both sides must pass before the change ships.
