// The User-Agent the viewer sends to Podcast Index when PI_USER_AGENT is not set:
// `<AppName>/<version> (+<link>)`. No email, no browser imitation.
//
// - APP_VERSION is pinned here so the built service needs nothing beside dist/;
//   user-agent.test.ts keeps it equal to package.json.
// - APP_URL is the viewer's public site.
// - The Hive calls go through @hiveio/dhive, which sends its own `dhive/<version>`.
export const APP_NAME = 'msp-podping-viewer';
export const APP_VERSION = '1.0.0';
export const APP_URL = 'https://pp.musicsideproject.com';

export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (+${APP_URL})`;
