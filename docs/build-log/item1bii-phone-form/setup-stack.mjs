import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const directory = resolve(process.env.PHONE_STACK_DIR ?? ".odos/phone-proof");
const port = Number(process.env.PHONE_MEDPLUM_PORT ?? 19313);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const privateFile = resolve(directory, "credentials.json");
if (!existsSync(privateFile)) {
  const secret = () => randomBytes(32).toString("base64url");
  const passphrase = secret();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const credentials = { baseUrl: `http://127.0.0.1:${port}`, email: "synthetic-phone-proof@example.test", password: `${secret()}.Aa1` };
  const databasePassword = secret();
  const redisPassword = secret();
  const config = JSON.parse(readFileSync("medplum.config.json", "utf8"));
  Object.assign(config, { baseUrl: `${credentials.baseUrl}/`, appBaseUrl: "http://127.0.0.1:15139/", storageBaseUrl: `${credentials.baseUrl}/storage/`, binaryStorage: "file:/tmp/phone-proof-binary/", signingKeyId: "synthetic-phone-proof", signingKey: privateKey, signingKeyPassphrase: passphrase, defaultSuperAdminEmail: credentials.email, defaultSuperAdminPassword: credentials.password });
  config.database.password = databasePassword;
  config.redis.password = redisPassword;
  const compose = { services: {
    postgres: { image: "postgres:16-alpine", environment: { POSTGRES_DB: "medplum", POSTGRES_USER: "medplum", POSTGRES_PASSWORD: databasePassword }, volumes: ["database:/var/lib/postgresql/data"], healthcheck: { test: ["CMD-SHELL", "pg_isready -U medplum -d medplum"], interval: "2s", timeout: "2s", retries: 30 } },
    redis: { image: "redis:7-alpine", command: ["redis-server", "--requirepass", redisPassword] },
    medplum: { image: "medplum/medplum-server:5.1.30", depends_on: { postgres: { condition: "service_healthy" }, redis: { condition: "service_started" } }, ports: [`127.0.0.1:${port}:8103`], volumes: [`${directory}/medplum.json:/config/medplum.json:ro`], command: ["file:/config/medplum.json"] },
  }, volumes: { database: {} } };
  for (const [name, value] of [["credentials.json", credentials], ["medplum.json", config], ["compose.json", compose]]) {
    writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  }
}
execFileSync(process.env.PHONE_COMPOSE_BIN ?? "docker-compose", ["-p", "odos-phone-textable", "-f", resolve(directory, "compose.json"), "up", "-d"], { stdio: "inherit" });
const credentials = JSON.parse(readFileSync(privateFile, "utf8"));
let ready = false;
for (let attempt = 0; attempt < 90; attempt++) {
  try { ready = (await fetch(`${credentials.baseUrl}/healthcheck`)).ok; } catch { /* Startup can precede the listener. */ }
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(ready, "Disposable Medplum did not become healthy");
console.log(`Disposable Medplum ready at ${credentials.baseUrl}; private credentials retained in the untracked proof directory.`);
