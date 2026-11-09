# vars-secrets: one binary, different settings

`vars` are compiled in. `secrets` never are: a standalone binary reads its port,
data directory and secrets from the environment when it starts, so the same file
runs on a laptop and on a server with different settings. `sproutboat run`
builds that environment and refuses to start if a declared secret is missing.

```sh
sproutboat build --standalone            # once: dist/vars-secrets

# development: a local env file, port 8080, data under ./dev-data
cp dev.env.example dev.env               # edit the key
sproutboat run --env-file dev.env --port 8080 --data-dir ./dev-data
curl localhost:8080/                     # hej, your key ends in ...-key

# production: the identical binary, a different file, port and data root
sproutboat run --env-file /etc/vars-secrets/prod.env --port 80 --data-dir /var/lib/vars-secrets
# or layer files: a later --env-file overrides an earlier one
sproutboat run --env-file base.env --env-file prod.env --port 80
```

Check the secrets without starting anything:

```sh
sproutboat run --env-file prod.env --check
# secrets   API_KEY (env file)
# ✓ ready to launch vars-secrets (not started: --check)
```

Precedence, highest first: `--port` and `--data-dir`, then the `--env-file`
files, then the environment `sproutboat run` was started from. A declared secret
that is unset or empty in all three fails the launch (as `wrangler deploy` does
for a missing required secret), and no value is ever printed.

`sproutboat dev` follows Wrangler instead: it reads `.dev.vars` or the `.env`
files (never both), `--env-file dev.env` replaces the default set, the process
environment is not passed, and a missing secret is a warning. Keep env files out
of version control (`.dev.vars` already is, in the `init` starter).

On a server without the CLI, systemd does the same job with
`EnvironmentFile=/etc/vars-secrets/prod.env`; see
[docs/standalone.md](../../docs/standalone.md#launching-with-sproutboat-run).
