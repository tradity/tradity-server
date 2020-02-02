"use strict";

const crypto = require('crypto');

function md5(s) {
  const h = crypto.createHash('md5');
  h.end(s);
  return h.read().toString('hex');
}

module.exports = {
  'db': {
    'user': 'sotrade',
    'database': 'sotrade',
    'supportBigNumbers': true,
    'stringifyObjects': true,
    'multipleStatements': true,
    'connectionLimit': 8,
    'trace': true,
    'connectTimeout': null,
    'acquireTimeout': null,
  },
  'configureSocketIO': function(/*sio, cfg*/) {
    return {
      'browser client minification': true,
      'browser client etag': true,
      'browser client gzip': true
    };
  },
  'wshost': 'localhost',
  'wsports': [4094, 4095, 4096, 4097, 4098, 4099],
  'userAgent': 'Tradity.de server (+tech@tradity.de NodeJS ' + process.version + ' http)',
  'mail': {
    'messageIdHostname': 'tradity.de',
    'transport': 'nodemailer-smtp-pool',
    'transportData': {
      'host': 'entless.org',
      'port': 587,
      'requireTLS': true,
      'auth': {
        'user': 'tech@tradity.de'
      }
    },
    'errorBase': {
      'from': 'tech@tradity.de',
      'to': 'server-error@tradity.de',
      'subject': 'SoTrade Error'
    },
  },
  'clientconfig': [
    'regurl', 'leaderValueShare', 'transactionFeePerc', 'transactionFeeMin', 'betakeyRequired', 'stayloggedinTime', 'normalLoginTime',
    'stockExchanges', 'fsdb', 'maxSingleStockShare', 'hostname', 'regurl', 'inviteurl', 'resetAllowed',
    'defaultWProvision', 'defaultLProvision', 'minWProvision', 'maxWProvision', 'minLProvision', 'maxLProvision',
    'ranking', 'languages', 'protocol', 'DLAValidityDays'
  ],
  'languages': [
    { 'id': 'de', name: 'Deutsch', englishName: 'German' },
    { 'id': 'en', name: 'English', englishName: 'English' }
  ],
  'regurl': '{$protocol}://{$hostname}/login/{$key}/{$uid}',
  'inviteurl': '{$protocol}://{$hostname}/join/{$key}',
  'lrutimeLimit': 1000,
  'refetchLimit': 260,
  'defaultStartingMoney': 1000000000,
  'leaderValueShare': 100,
  'maxSingleStockShare': 0.5,
  'transactionFeePerc': 0.0010,
  'transactionFeeMin': 100000,
  'betakeyRequired': false,
  'stayloggedinTime': 3628800,
  'normalLoginTime': 1800,
  'delayOrderHistTime': 2 * 86400,
  'popularStocksDays': 21,
  'DLAValidityDays': 100,
  'stockExchanges': {
    'XETR': {open: '9:00', close: '17:30', days: [1,2,3,4,5]},
    'tradity': {open: '9:00', close: '17:30', days: [1,2,3,4,5]}
  },
  'timezone': 'Europe/Berlin',
  'requireCurrency': 'EUR',
  'minAskPrice': 10,
  'infopushMinDelta': 60000,
  'fsdb': {
    'puburl': '/dynamic/files/{$name}',
    'userquota': 3000000, // 3 MB
    'uniqroles': {
      'profile.image': ['uid'],
      'schools.banner': ['groupassoc']
    },
    'allowroles': ['profile.image', 'schools.banner'],
    'allowmime': ['image/png', 'image/gif', 'image/jpeg'],
    'allowProxyURIs': [
      {
        'regex': /^https?:\/\/(\w+\.)?gravatar\.com\/avatar\/(\w+)(\?s=\d+)?$/,
        'requireAccess': (ctx, match) => {
          return ctx.access.has('email_verif') && match[2] === md5(ctx.user.email);
        }
      }
    ]
  },
  'hostname': 'game.tradity.de',
  'protocol': 'https',
  'resetAllowed': false,
  'schoolConfigDefaults': {
    'ranking': {
      'since': null,
      'upto': null,
      'extraTabs': []
    }
  },
  'ranking': {
    'since': null,
    'upto': null,
    'extraTabs': []
  },
  'defaultWProvision': 15,
  'defaultLProvision': 0,
  'minWProvision': 5,
  'maxWProvision': 30,
  'minLProvision': 0,
  'maxLProvision': 30,
  'errorLogFile': 'errors.{$pid}.log',
  'configFiles': {
    'prefixes': ['/etc/sotrade/config.', './config/config.', '../server-config/config.']
  },
  'readonly': false,
  'publicKeys': [ 'acceptedPublicKeys' ],
  'startBackgroundWorker': true,
  'socketIORemotes': [],
  'ssl': {},
  'stockloaders': {
    'boerse-frankfurt': {
      'path': './stockloaders/boerse-frankfurt.js',
      'infoLink': 'missing',
      'mic': 'XETR',
      'timezone': 'Europe/Berlin'
    },
    'loopback': {
      'path': './stockloaders/loopbackloader.js',
      'literal': false
    },
    'loopback-literal': {
      'path': './stockloaders/loopbackloader.js',
      'literal': true
    },
    'temporally-composite': {
      'path': './stockloaders/temporally-composite.js',
      'bases': [
        {
          'conditions': [
            { 'type': 'after',  'time': '08:57' },
            { 'type': 'before', 'time': '17:33' }
          ],
          'loader': 'boerse-frankfurt'
        },
        {
          'loader': 'loopback-literal'
        }
      ]
    },
    'temporally-composite-testing': {
      'path': './stockloaders/temporally-composite.js',
      'bases': [
        {
          'conditions': [
            { 'type': 'after',  'time': '08:57' },
            { 'type': 'before', 'time': '17:33' }
          ],
          'loader': 'loopback'
        },
        {
          'loader': 'loopback-literal'
        }
      ]
    },
    '_defaultStockLoader': 'temporally-composite'
  },
  'passwords': {
    'pbkdf2Iterations': 18,
    'pbkdf2MinIterations': 18
  },
  'forbidLeaderTrades': true,
  'redis': { '_channel': 'sotrade' }
};
