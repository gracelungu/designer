// electron-builder reads this file. The settings, and how signing turns on, are in build/builder-config.cjs.
const { buildConfig } = require('./build/builder-config.cjs');

module.exports = buildConfig(process.env);
