'use strict';

Error.stackTraceLimit = Infinity;
process.env.SOTRADE_ERROR_LOG_FILE = '/tmp/errors-' + Date.now() + '.log';
//process.env.SOTRADE_DO_NOT_OUTPUT_ERRORS = 1;
process.env.SOTRADE_NO_CLUSTER = 1;
process.env.DEBUG = 'sotrade:*,-sotrade:bus:*';

// use config.test.js
process.env.SOTRADE_CONFIG = 'test';
const config = require('../config.js');
config.reloadConfig();
