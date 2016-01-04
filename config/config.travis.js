module.exports = {
  'db': {
    'cluster': {
      'MASTER': {
        'socketPath': '/var/run/mysqld/mysqld.sock',
        'host': null,
        'writable': true,
        'readable': true
      }
    },
    'clusterOptions': {
      'defaultSelector': 'ORDER',
      'order': ['MASTER'],
    },
    'user': 'travis',
    'password': ''
  },
  'wshost': '::',
  'hostname': 'localhost',
  'protocol': 'http'
};
