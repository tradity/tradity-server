'use strict';

Error.stackTraceLimit = Infinity;
process.env.SOTRADE_ERROR_LOG_FILE = '/tmp/errors-' + Date.now() + '.log';
process.env.SOTRADE_DO_NOT_OUTPUT_ERRORS = 1;
process.env.SOTRADE_NO_CLUSTER = 1;
process.env.DEBUG = '*';

// use config.test.js
process.env.SOTRADE_CONFIG = 'test';
var config = require('../config.js');
config.reloadConfig();

var cfg = config.config();

var Q = require('q');
var assert = require('assert');
var fs = require('fs');
var lzma = require('lzma-native');
var stream = require('stream');
var spawn = require('child_process').spawn;

var streamMultiPipe = function(streams) {
	var out = new stream.PassThrough();
	var i = 0;
	
	var pipeNextStream = function() {
		if (i >= streams.length)
			return;
		
		streams[i].pipe(out, { end: i == streams.length - 1 });
		streams[i].on('end', pipeNextStream);
		i++;
	};
	
	pipeNextStream();
	
	return out;
};

var setupDatabase = function() {
	if (process.env.SOTRADE_TEST_SKIP_DB_SETUP)
		return Q();

	console.error("Setting up database...");
	
	var decompressor = lzma.createDecompressor();
	
	var sqlSetupStream = streamMultiPipe([
		fs.createReadStream('res/testdb-preamendments.sql'),
		fs.createReadStream('res/testdb.sql.xz').pipe(decompressor),
		fs.createReadStream('res/testdb-postamendments.sql')
	]);
	
	var mysqlConfig = '[client]\n' +
	'socket=' + cfg.db.cluster.MASTER.socketPath + '\n' +
	'password=' + cfg.db.password + '\n' +
	'user=' + cfg.db.user + '\n' +
	'database=' + cfg.db.database + '\n';
	var mysqlConfigFilename = 'res/test-mysql-config-' + Date.now();

	fs.writeFileSync(mysqlConfigFilename, mysqlConfig, { mode: 384 /* 0600 */ });
	
	var mysqlRunner = spawn('mysql', ['--defaults-file=' + mysqlConfigFilename], {
		stdio: ['pipe', process.stdout, process.stderr]
	});
	
	sqlSetupStream.pipe(mysqlRunner.stdin);
	
	var deferred = Q.defer();
	
	mysqlRunner.on('close', function(code) {
		fs.unlinkSync(mysqlConfigFilename);
		
		if (code !== 0)
			return deferred.reject(new Error('mysql process exited with error code ' + code));
		
		console.error("Set up database.");
		return deferred.resolve();
	});
	
	return deferred.promise;
};

var generateKeys = function() {
	var deferred = Q.defer();
	
	console.error("Generating keys...");
	
	/* make sure we are not overwriting actual non-testing private keys */
	assert.equal(cfg.privateKey, 'res/test-id_rsa');
	assert.equal(cfg.publicKeys[0], 'res/test-id_rsa.pub');
	
	var privateKeyGen = spawn('openssl', ['genrsa', '1024'], {
		stdio: ['ignore', fs.openSync(cfg.privateKey, 'w'), process.stderr]
	});
	
	privateKeyGen.on('close', function(code) {
		if (code !== 0)
			return deferred.reject(new Error('openssl genrsa exited with error code ' + code));
		
		var publicKeyGen = spawn('openssl', ['rsa', '-in', cfg.privateKey, '-pubout'], {
			stdio: ['ignore', fs.openSync(cfg.publicKeys[0], 'w'), process.stderr]
		});
		
		publicKeyGen.on('close', function(code) {
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
