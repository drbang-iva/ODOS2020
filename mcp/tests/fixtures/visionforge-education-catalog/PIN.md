# C0 contract fixture

PINNED_VISIONFORGE_REVISION: 29fb8738a71a6ab69fe01b5565c07f10db88e09f

Captured through the real VisionForge repository, Hono route, seam authorization and projection. Every item has `dxCodes: []`. The runtime received a distinct random admin hash; no admin token was created or used.

Exact capture commands (disposable password redacted; generated seam token stayed private):

```sh
git -C /Users/ericr.bang/GitHub/visionforge worktree add /tmp/vf-o1-capture 29fb873
ln -s /Users/ericr.bang/GitHub/visionforge/node_modules /tmp/vf-o1-capture/node_modules
docker run -d --name odos-o1-vf-pg -e POSTGRES_DB=visionforge -e POSTGRES_USER=visionforge_owner -e POSTGRES_PASSWORD=<redacted> -p 127.0.0.1::5432 pgvector/pgvector:0.8.6-pg17
docker exec odos-o1-vf-pg psql -U visionforge_owner -d visionforge -c "CREATE ROLE visionforge_app WITH LOGIN PASSWORD '<redacted>'"
docker exec odos-o1-vf-pg psql -U visionforge_owner -d visionforge -c 'GRANT visionforge_app TO visionforge_owner'
docker exec odos-o1-vf-pg psql -U visionforge_owner -d visionforge -c 'CREATE DATABASE odos_o1'
o1_port=$(docker port odos-o1-vf-pg 5432 | awk -F: '{print $NF}')
O1_VF_OWNER_URL="postgres://visionforge_owner:<redacted>@127.0.0.1:${o1_port}/visionforge" O1_SERVE=1 bun mcp/tests/fixtures/visionforge-education-catalog/capture.ts
```

Actual disposable Postgres host port: 32774. The successful fresh capture applied 31 migrations. The fixture generator salts receipt manifests per capture so the real writer's synthetic digests do not trip ODOS's broad ten-digit fixture scanner; captured bodies and headers remain verbatim, never hand-edited.

The partial version is first fully published through the repository and captured in `before-absence.body`. Owner SQL then removes its non-web publication receipts, leaving the declared multi-channel version with one published channel. This is the rev-3 partial-publication exception. All other content, reviews, publications, supersession and withdrawal use the real repository API.

Capture outcome: 200 with ETag; 304 with empty body; same token on foreign practice 401; anonymous 401. The last two response bodies match. Published entries: active 1, retained 1, withdrawn 1. The technical fixture and partial version are omitted. `before-absence.body` contains `partial@1` for the durable carry-forward test.

Verbatim capture output:
```json
{"capture":"C0","statuses":[200,304,401,401],"entries":3,"migrations":31}
```

SHA-256 of each file, in hexadecimal bytes. Concatenate the byte pairs to recover the standard digest. `PIN.md` excludes itself.

| File | SHA-256 bytes |
|---|---|
| MUTATION-RESULTS.md | `6a 1f d9 34 ef 5f c2 38 2f 85 04 7b 48 6d b9 4d 6a 6b bb bb 5e c3 4d a3 98 a8 2b 2b 1d b9 d5 f1` |
| anonymous.body | `c2 85 a5 b8 71 ff fa f3 18 77 38 24 9e f3 62 c1 85 63 23 d0 54 33 63 1d 96 38 2b 48 56 80 ec 20` |
| anonymous.response.json | `58 92 13 5d 83 bf 1f ea ab 69 fb f9 9c f7 f9 9b a9 ac 52 4c ad 45 be 8e 97 27 61 52 0d 22 2f 8b` |
| before-absence.body | `28 c9 b9 c9 8d 26 27 b7 f8 bd aa f7 88 a2 e6 3d c9 fc 75 0d d9 52 d0 50 8c c1 5b d7 32 3e e3 9e` |
| before-absence.response.json | `69 38 48 72 ef af 45 32 46 00 17 f6 c2 39 1a dd 23 ea 06 aa fa 7a 06 f8 c1 fa e7 ec d2 de 4b 00` |
| capture-result.json | `de 98 43 19 b2 0d 69 8b a5 21 7e 8d 7f 69 bd 7a 16 6d bf 09 99 0f 1c eb 76 7c f3 69 b0 f8 29 bc` |
| capture.ts | `f2 f0 50 e3 aa 7e 96 b4 e8 c3 4b 4c 52 48 ce a9 59 49 d3 81 57 50 d5 87 c0 54 10 75 11 56 28 87` |
| catalog.body | `42 3f 9f 77 ef 05 46 77 65 c4 7a 85 01 28 1f f4 35 3a 86 d5 d2 94 db 93 82 fe 5f 5d 07 5c dc 83` |
| catalog.response.json | `15 6d a0 47 35 0d 1a 1c 38 aa e6 1e b5 93 41 7f 4b ef d7 c1 ac a1 09 c8 80 5a 90 b2 92 0c 00 c5` |
| foreign-practice.body | `c2 85 a5 b8 71 ff fa f3 18 77 38 24 9e f3 62 c1 85 63 23 d0 54 33 63 1d 96 38 2b 48 56 80 ec 20` |
| foreign-practice.response.json | `58 92 13 5d 83 bf 1f ea ab 69 fb f9 9c f7 f9 9b a9 ac 52 4c ad 45 be 8e 97 27 61 52 0d 22 2f 8b` |
| not-modified.body | `e3 b0 c4 42 98 fc 1c 14 9a fb f4 c8 99 6f b9 24 27 ae 41 e4 64 9b 93 4c a4 95 99 1b 78 52 b8 55` |
| not-modified.response.json | `b8 7e 87 ab 46 c7 4a 50 ab 57 db b2 85 fc 47 58 4b e9 2e c5 13 e7 34 27 aa 41 b3 10 53 76 7f 59` |
