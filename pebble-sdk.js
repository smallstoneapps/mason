var PEBBLE_SDK_ROOT = '/home/ubuntu/pebble-dev/';

var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');

var PebbleSdk = function (version) {
  this.version = version;
  this.ok = false;
  if (fs.existsSync(this.getFolder())) {
    this.ok = true;
  }
}

PebbleSdk.prototype.getFolder = function () {
  return path.join(PEBBLE_SDK_ROOT, 'PebbleSDK-' + this.version);
}

PebbleSdk.prototype.initApp = function (folder, callback) {

  var command = spawn(path.join(this.getFolder(), 'Pebble', 'tools', 'create_pebble_project.py'),
    [
      '--symlink-only',
      path.join(this.getFolder(), 'Pebble', 'sdk'),
      folder
    ]
  );

  var result = {
    code: 0,
    stdout: '',
    stderr: ''
  };

  command.stdout.on('data', function (data) {
    result.stdout += data;
  });

  command.stderr.on('data', function (data) {
    result.stderr += data;
  });

  command.on('close', function (code) {
    result.code = code;
    callback(result);
  });

}

PebbleSdk.prototype.configureApp = function (folder, callback) {

  var command = spawn('./waf', [ 'configure' ], { cwd: folder });
  var result = {
    code: 0,
    stdout: '',
    stderr: ''
  };

  command.stdout.on('data', function (data) {
    result.stdout += data;
  });

  command.stderr.on('data', function (data) {
    result.stderr += data;
  });

  command.on('close', function (code) {
    result.code = code;
    callback(result);
  });

}

PebbleSdk.prototype.buildApp = function (folder, callback) {

  var command = spawn('./waf', [ 'clean', 'build' ], { cwd: folder });
  var result = {
    code: 0,
    stdout: '',
    stderr: ''
  };

  command.stdout.on('data', function (data) {
    result.stdout += data;
  });

  command.stderr.on('data', function (data) {
    result.stderr += data;
  });

  command.on('close', function (code) {
    result.code = code;
    callback(result);
  });

}

module.exports = PebbleSdk;