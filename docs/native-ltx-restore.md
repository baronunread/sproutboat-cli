# Native offline LTX restore

`sproutboat build --standalone --with-restore` and the `APP ltx-restore --generation DIR --output NEW_DB` startup
command are gone. The flag now fails with a message that says so.

Offline restore of an LTX backup will come back as a plain CLI command, `sproutboat restore`, run from the
machine that holds the backup: the restore logic belongs to the CLI (Bun), not to every deployed executable, so
a standalone binary no longer carries a second program, and the restore does not constrain which Porffor the
binaries are built with. Until then, an LTX generation can be restored with Litestream or the LTX tooling it came
from.

What was removed: the `--with-restore` build flag, the native restore codec under `vendor/ltx-restore/`, and the
alpha 19 build it required (restore objects were compiled against alpha 19's native-fetch C API). History:
`git log -- docs/native-ltx-restore.md` has the previous document.
