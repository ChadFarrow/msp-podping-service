// The one User-Agent that the consumer (and its CLI tools) send:
// `<AppName>/<version> (+<link>)`. No email, no browser imitation.
//
// - APP_NAME is the service this consumer runs in (the same container as the
//   pusher), as the old `msp-podping-service/1.0` name was.
// - APP_VERSION is pinned here, not read from package.json at run time, so the
//   built image needs nothing beside dist/. user-agent.test.ts keeps it equal to
//   package.json.
// - APP_URL is the public repo: the consumer has no site of its own.
// - The Hive calls go through @hiveio/dhive, which sends its own `dhive/<version>`.
export const APP_NAME = 'msp-podping-service';
export const APP_VERSION = '1.0.0';
export const APP_URL = 'https://github.com/ChadFarrow/msp-podping-service';

export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (+${APP_URL})`;
