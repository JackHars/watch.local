// New names take precedence; legacy names keep existing installations working.
export const environment = name => process.env[`WATCHLOCAL_${name}`] ?? process.env[`FREEIPTV_${name}`];
