var _         = require('underscore');
var async     = require('async');
var AWS       = require('aws-sdk');
var config    = require('config');
var express   = require('express');
var Firebase  = require('firebase');
var fs        = require('fs');
var http      = require('http');
var httpget   = require('http-get')
var kue       = require('kue');
var mkdirp    = require('mkdirp');
var moment    = require('moment');
var path      = require('path');
var PebbleSdk = require('./pebble-sdk');
var redis     = require('redis');
var request   = require('request');
var rimraf    = require('rimraf');
var stathat   = require('stathat');
var url       = require('url');
var uuid      = require('node-uuid');

var APP_NAME_REGEX = new RegExp("[A-Za-z0-9\ ]");

var FirebaseDb = new Firebase(config.firebase.url);
FirebaseDb.auth(config.firebase.authToken);

AWS.config.loadFromPath(config.aws.configFile);
var s3 = new AWS.S3();

var PebbleSdkVersions = [ '1.12' ];
var PebbleSdks = {};
_.each(PebbleSdkVersions, function (version) {
  var sdk = new PebbleSdk(version);
  if (sdk.ok) {
    PebbleSdks[version] =sdk;
  }
  else {
    console.log('SDK v' + version + ' is not OK');
  }
});

// Kue Code

var workerQueue = kue.createQueue();
kue.app.listen(config.kue.port);

workerQueue.process('download', function (job, done) {
  var id = job.data.id;

  updateBuildState(id, 'working');
  addBuildTimingEntry(id, 'download started');
  downloadBuildFiles(id, function (err) {
    if (err) {
      console.log('Download failed [' + id + ']');
      recordStatCount('download failures');
      updateBuildState(id, 'error');
      setBuildError(id, err);
      done(err);
      workerQueue.create('cleanup', job.data).save();
      return;
    }
    updateBuildState(id, 'done');
    addBuildTimingEntry(id, 'download finished');
    done();

    workerQueue.create('compile', job.data).save();
    updateBuildStep(id, 'compile');
    updateBuildState(id, 'queued');
  });
});

workerQueue.process('compile', function (job, done) {
  var id = job.data.id;

  updateBuildState(id, 'working');
  addBuildTimingEntry(id, 'compile started');

  compileBuild(id, function (err) {
    if (err) {
      console.log('Compile failed [' + id + ']');
      recordStatCount('compile failures');
      updateBuildState(id, 'error');
      setBuildError(id, err);
      done(err);
      workerQueue.create('cleanup', job.data).save();
      return;
    }
    updateBuildState(id, 'done');
    addBuildTimingEntry(id, 'compile finished');
    done();

    workerQueue.create('upload', job.data).save();
    updateBuildStep(id, 'upload');
    updateBuildState(id, 'queued');
  });
});

workerQueue.process('upload', function (job, done) {
  var id = job.data.id;

  updateBuildState(id, 'working');
  addBuildTimingEntry(id, 'upload started');

  uploadBuild(id, function (err) {
    if (err) {
      console.log('Upload failed [' + id + ']');
      recordStatCount('upload failures');
      updateBuildState(id, 'error');
      setBuildError(id, err);
      done(err);
      workerQueue.create('cleanup', job.data).save();
      return;
    }
    done();
    updateBuildState(id, 'done');
    addBuildTimingEntry(id, 'upload finished');

    workerQueue.create('tidy', job.data).save();
    updateBuildStep(id, 'tidy');
    updateBuildState(id, 'queued');
  });
});

workerQueue.process('tidy', function (job, done) {
  var id = job.data.id;

  updateBuildState(id, 'working');
  addBuildTimingEntry(id, 'tidy started');

  tidyBuild(id, function (err) {
    if (err) {
      console.log('Tidy failed [' + id + ']');
      // Disabled due to limited number of StatHat stats. //
      //recordStatCount('tidy failures');
      updateBuildState(id, 'error');
      setBuildError(id, err);
      return done(err);
    }
    done();
    updateBuildState(id, 'done');
    addBuildTimingEntry(id, 'tidy finished');
    addBuildTimingEntry(id, 'done');

    recordTimingStats(id);
  });
});

workerQueue.process('cleanup', function (job, done) {
  var id = job.data.id;
  cleanFailedBuild(id, function (err) {
    if (err) {
      console.log('Clean failed [' + id + ']');
      // Disabled due to limited number of StatHat stats. //
      //recordStatCount('cleanup failures');
      return done(err);
    }
    done();
  })
});

// End Kue Code

// Express Code

var app = express();

app.set('port', config.express.port);
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(app.router);

app.get('/', function (req, res) {
  res.redirect('http://builder.pblweb.com/');
});

app.post('/build/', function (req, res) {
  createNewBuild(req.body, function (err, id) {
    if (err) {
      return res.json(400, { error: err });
    }
    return res.json(200, { id: id });
  });
});

app.get('/status/', function (req, res) {
  getBuildInfo(req.query.id, function (err, info) {
    return res.json({ step: info.step, state: info.state });
  });
});

http.createServer(app).listen(app.get('port'), function () {});

// End Express Code

function createNewBuild(info, callback) {
  var infoProblem = isValidBuildInfo(info);
  if (infoProblem !== null) {
    return callback(infoProblem);
  }
  var id = generateBuildId();
  fs.mkdir(path.join(config.misc.buildFolder, id), function (err) {
    if (err) {
      return callback('Unknown error occurred.');
    }
    info.step = 'download';
    info.state = 'queued';
    saveBuildInfo(id, info);
    addBuildTimingEntry(id, 'created');
    workerQueue.create('download', {
      id: id,
      title: id
    }).save();
    recordStatCount('builds');
    return callback(null, id);
  });
}

function isValidBuildInfo(info) {
  // Validate SDK version.
  if (! info.sdkVersion) {
    return 'Missing "sdkVersion".';
  }
  if (! _.has(PebbleSdks, info.sdkVersion)) {
    return 'Unknown sdkVersion "' + info.sdkVersion + '".';
  }
  // Validate list of files.
  if (! info.files) {
    return 'Missing "files".';
  }
  if (info.files.length < 2) {
    return 'Not enough files.';
  }
  // TODO: Make sure files are not malicious!
  if (! _.every(info.files, function (file) {
    try {
      // Validate the URL part of the file.
      var urlObj = url.parse(file.url);
      if (! urlObj) {
        return false;
      }
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        return false;
      }
      // Validate the file part of the file.
      var filePath = path.normalize(file.path);
      if (! filePath.length) {
        return false;
      }
      if (filePath.substr(0, 1) === '.') {
        return false;
      }
    }
    catch (e) {
      return false;
    }
    return true;
  })) {
    return 'Bad list of files.';
  }
  // Validate user token.
  if (! info.userToken) {
    return 'Missing "userToken".';
  }
  if (info.userToken !== 'P7S1bAKN24Tnq3pE') {
    return 'Invalid userToken "' + userToken + '".';
  }
  // Validate app name.
  if (! info.appName || ! info.appName.length) {
    return 'Missing "appName".';
  }
  if (! APP_NAME_REGEX.test(info.appName)) {
    return 'Invalid appName "' + info.appName + '"';
  }
  return null;
}

function generateBuildId() {
  return uuid.v4();
}

function downloadBuildFiles(id, callback) {
  getBuildInfo(id, function (err, build) {
    async.each(build.files, function (filePair, callback) {
      var filePath = filePair.path;
      if (filePath.substr(0, 1) === '/') {
        filePath = filePath.substr(1);
      }
      var fileUrl = filePair.url;
      var folder = path.dirname(filePath);
      mkdirp(path.join(config.misc.buildFolder, id, folder), function (err) {
        if (err) {
          return callback(err);
        }
        var file = path.join(config.misc.buildFolder, id, filePath);
        httpget.head(fileUrl, function (err, res) {
          if (err) {
            return callback(err);
          }
          var overrideSizeCheck = false;
          if (fileUrl.substr(0, 24) === 'https://gist.github.com/' || fileUrl.substr(0, 23) === 'http://gist.github.com/') {
            overrideSizeCheck = true;
          }
          if (! overrideSizeCheck && ! res.headers['content-length']) {
            return callback(new Error('Unknown file size for "' + fileUrl + '".'));
          }
          if (parseInt(res.headers['content-length']) > config.misc.maxDownloadSize) {
            return callback(new Error('File too large for "' + fileUrl + '".'));
          }
          httpget.get(fileUrl, file, function (err, res) {
            return callback(err);
          })
        })
      });
    }, callback);
  })
}

function compileBuild(id, callback) {
  getBuildInfo(id, function (err, build) {
    var folder = path.join(config.misc.buildFolder, id);
    var sdk = PebbleSdks[build.sdkVersion];
    if (! sdk) {
      return callback(new Error('Unknown SDK "' + build.sdkVersion + '"'));
    }

    sdk.initApp(folder, function (res) {
      if (res.code !== 0) {
        return callback(res.stderr);
      }
      sdk.configureApp(folder, function (res) {
        if (res.code !== 0) {
          return callback(res.stderr);
        }
        sdk.buildApp(folder, function (res) {
          if (res.code !== 0) {
            return callback(res.stderr);
          }
          return callback();
        })
      })
    })
  })
}

function uploadBuild(id, callback) {
  getBuildInfo(id, function (err, build) {
    var folder = path.join(config.misc.buildFolder, id);

    var buildPath = path.join(folder, 'build', id + '.pbw');
    fs.exists(buildPath, function (exists) {
      if (! exists) {
        err = new Error('Build file does not exist.');
        return callback(err);
      }

      fs.readFile(buildPath, function (err, buildData) {
        if (err) {
          return callback(err);
        }
        var s3File = {
          Bucket: 'builder.pblweb.com',
          Key: [ id, 'build.pbw' ].join('/'),
          ACL:'public-read',
          Body: buildData
        };
        s3.client.putObject(s3File, callback);
      });
    });
  });
}

function tidyBuild(id, callback) {
  var folder = path.join(config.misc.buildFolder, id);
  rimraf(folder, function (err) {
    callback(err);
  });
}

function cleanFailedBuild(id, callback) {
  var folder = path.join(config.misc.buildFolder, id);
  rimraf(folder, function (err) {
    callback(err);
  });
}

function recordStatCount(stat, count) {
  if (typeof count === 'undefined') {
    count = 1;
  }
  var statName = [ config.stathat.prefix, stat ].join(' ');
  if (! config.stathat.enabled) {
    console.log('Fake StatHat Count:', statName, count);
    return;
  }
  stathat.trackEZCount(config.stathat.email, statName, count, function (status, json) {
    if (status !== 200) {
      console.log('StatHat failed (' + status + ')');
    }
  });
}

function recordStatValue(stat, value) {
  if (typeof value === 'undefined') {
    value = 1;
  }
  var statName = [ config.stathat.prefix, stat ].join(' ');
  if (! config.stathat.enabled) {
    console.log('Fake StatHat Count:', statName, value);
    return;
  }
  stathat.trackEZValue(config.stathat.email, statName, value, function (status, json) {
    if (status !== 200) {
      console.log('StatHat failed (' + status + ')');
    }
  });
}

function recordTimingStats(id) {
  getBuildInfo(id, function (err, build) {
    var downloadTime = build.timings['download finished'] - build.timings['download started'];
    var compileTime = build.timings['compile finished'] - build.timings['compile started'];
    var uploadTime = build.timings['upload finished'] - build.timings['upload started'];
    var tidyTime = build.timings['tidy finished'] - build.timings['tidy started'];

    var queueDownload = build.timings['download started'] - build.timings['created'];
    var queueCompile = build.timings['compile started'] - build.timings['download finished'];
    var queueUpload = build.timings['upload started'] - build.timings['compile finished'];
    var queueTidy = build.timings['tidy started'] - build.timings['upload finished'];

    var queueTotal = queueDownload + queueCompile + queueUpload + queueTidy;
    var totalTime = build.timings['done'] - build.timings['created'];

    recordStatValue('download time', downloadTime / 1000);
    recordStatValue('compile time', compileTime / 1000);
    recordStatValue('upload time', uploadTime / 1000);
    recordStatValue('queue time', queueTotal / 1000);
    recordStatValue('total time', totalTime / 1000);
  });
}

function saveBuildInfo(id, info) {
  var buildRef = FirebaseDb.child(id);
  buildRef.set(info);
}

function getBuildInfo(id, callback) {
  var buildRef = FirebaseDb.child(id);
  buildRef.once('value', function (snapshot) {
    return callback(null, snapshot.val());
  });
}

function updateBuildStep(id, step) {
  var buildRef = FirebaseDb.child(id);
  buildRef.child('step').set(step);
}

function updateBuildState(id, state) {
  var buildRef = FirebaseDb.child(id);
  buildRef.child('state').set(state);
}

function setBuildError(id, error) {
  var buildRef = FirebaseDb.child(id);
  buildRef.child('error').set(error);
}

function addBuildTimingEntry(id, name) {
  var buildRef = FirebaseDb.child(id);
  buildRef.child('timings').child(name).set(moment().valueOf());
}