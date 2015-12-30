'use strict';

require('../common.js');
const cfg = require('../../config.js').config();
const assert = require('assert');
const fs = require('fs');
const lzma = require('lzma-native');
const stream = require('stream');
const spawn = require('child_process').spawn;

const streamMultiPipe = function(streams) {
  const out = new stream.PassThrough();
  let i = 0;
  
  const pipeNextStream = function() {
    if (i >= streams.length)
      return;
    
    streams[i].pipe(out, { end: i == streams.length - 1 });
    streams[i].on('end', pipeNextStream);
    i++;
  };
  
  pipeNextStream();
  
  return out;
};

const setupDatabase = function() {
  if (process.env.SOTRADE_TEST_SKIP_DB_SETUP)
    return Promise.resolve();

  console.error("Setting up database...");
  
  const decompressor = lzma.createDecompressor();
  
  const sqlSetupStream = streamMultiPipe([
    fs.createReadStream('res/testdb-preamendments.sql'),
    fs.createReadStream('res/testdb.sql.xz').pipe(decompressor),
    fs.createReadStream('res/testdb-postamendments.sql')
  ]);
  
  const mysqlConfig = '[client]\n' +
  'socket=' + cfg.db.cluster.MASTER.socketPath + '\n' +
  'password=' + cfg.db.password + '\n' +
  'user=' + cfg.db.user + '\n' +
  'database=' + cfg.db.database + '\n';
  const mysqlConfigFilename = 'res/test-mysql-config-' + Date.now();

  fs.writeFileSync(mysqlConfigFilename, mysqlConfig, { mode: 384 /* 0600 */ });
  
  const mysqlRunner = spawn('mysql', ['--defaults-file=' + mysqlConfigFilename], {
    stdio: ['pipe', process.stdout, process.stderr]
  });
  
  sqlSetupStream.pipe(mysqlRunner.stdin);
  
  const deferred = Promise.defer();
  
  mysqlRunner.on('close', code => {
    fs.unlinkSync(mysqlConfigFilename);
    
    if (code !== 0)
      return deferred.reject(new Error('mysql process exited with error code ' + code));
    
    console.error("Set up database.");
    return deferred.resolve();
  });
  
  return deferred.promise;
};

const generateKeys = function() {
  const deferred = Promise.defer();
  
  console.error("Generating keys...");
  
  /* make sure we are not overwriting actual non-testing private keys */
  assert.equal(cfg.privateKey, 'res/test-id_rsa');
  assert.equal(cfg.publicKeys[0], 'res/test-id_rsa.pub');
  
  const privateKeyGen = spawn('openssl', ['genrsa', '1024'], {
    stdio: ['ignore', fs.openSync(cfg.privateKey, 'w'), process.stderr]
  });
  
  privateKeyGen.on('close', code => {
    if (code !== 0)
      return deferred.reject(new Error('openssl genrsa exited with error code ' + code));
    
    const publicKeyGen = spawn('openssl', ['rsa', '-in', cfg.privateKey, '-pubout'], {
      stdio: ['ignore', fs.openSync(cfg.publicKeys[0], 'w'), process.stderr]
    });
    
    publicKeyGen.on('close', code => {
      if (code !== 0)
        return deferred.reject(new Error('openssl rsa -pubout exited with error code ' + code));
      
      console.error("Generated keys.");
      return deferred.resolve();
    });
  });
  
  return deferred.promise;
};

exports.setupDatabase = setupDatabase;
exports.generateKeys = generateKeys;
