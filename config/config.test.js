module.exports = {
  'wsports': [34094, 34095],
  'wshost': 'localhost',
  'wshoste': 'localhost',
  'db': {
    'database': 'sotrade_test'
  },
  'betakeyRequired': true,
  'stackTraceLimit': Infinity,
  'longStackTraces': true,
  'socketIORemotes': [
    {
      'url': 'http://localhost:34094/'
    }
  ],
  'mail': {
    'messageIdHostname': 'tradity.de',
    'transport': 'nodemailer-sendmail-transport',
    'transportData': {
      'path': process.cwd() + '/server-mailbounce.js',
      'args': ['--raw']
    }
  },
  'errorLogFile': process.env.SOTRADE_ERROR_LOG_FILE,
  'privateKey': 'res/test-id_rsa',
  'publicKeys': ['res/test-id_rsa.pub'],
  'stockExchanges': {
    'Frankfurt': {open: '1 1 1972 0:01 UTC', close: '31 12 2037 23:59 UTC', days: [1,2,3,4,5,6,7,0]},
    'tradity': {open: '1 1 1972 0:01 UTC', close: '31 12 2037 23:59 UTC', days: [1,2,3,4,5,6,7,0]}
  },
  'passwords': {
    // horrible security, performance just fine for testing
    'pbkdf2Iterations': 1,
    'pbkdf2MinIterations': 1
  },
  'stockloaders': {
    '_defaultStockLoader': 'loopback'
  },
  'login': {
    'minWait': 1,
    'maxWait': 2
  }
};
