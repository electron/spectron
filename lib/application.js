const Accessibility = require('./accessibility');
const Api = require('./api');
const ChromeDriver = require('./chrome-driver');
const DevNull = require('dev-null');
const fs = require('fs');
const path = require('path');
const WebDriver = require('webdriverio');

function Application(options) {
  options = options || {};
  this.host = options.host || '127.0.0.1';
  this.port = parseInt(options.port, 10) || 9515;

  this.quitTimeout = parseInt(options.quitTimeout, 10) || 1000;
  this.startTimeout = parseInt(options.startTimeout, 10) || 5000;
  this.waitTimeout = parseInt(options.waitTimeout, 10) || 5000;

  this.connectionRetryCount = parseInt(options.connectionRetryCount, 10) || 10;
  this.connectionRetryTimeout =
    parseInt(options.connectionRetryTimeout, 10) || 30000;

  this.nodePath = options.nodePath || process.execPath;
  this.path = options.path;

  this.args = options.args || [];
  this.chromeDriverArgs = options.chromeDriverArgs || [];
  this.env = options.env || {};
  this.workingDirectory = options.cwd || process.cwd();
  this.debuggerAddress = options.debuggerAddress;
  this.chromeDriverLogPath = options.chromeDriverLogPath;
  this.webdriverLogPath = options.webdriverLogPath;
  this.webdriverOptions = options.webdriverOptions || {};
  this.requireName = options.requireName || 'require';

  this.api = new Api(this, this.requireName);
  this.setupPromiseness();
}

Application.prototype.setupPromiseness = function () {
  const self = this;
  self.transferPromiseness = function (target, promise) {
    self.api.transferPromiseness(target, promise);
  };
};

Application.prototype.start = function () {
  const self = this;
  return self
    .exists()
    .then(function () {
      return self.startChromeDriver();
    })
    .then(function () {
      return self.createClient();
    })
    .then(function () {
      return self.api.initialize();
    })
    .then(function () {
      return self.client.setTimeout({
        implicit: self.waitTimeout,
        pageLoad: self.waitTimeout,
        script: self.waitTimeout
      });
    })
    .then(function () {
      self.running = true;
    })
    .then(function () {
      return self;
    });
};

Application.prototype.stop = function () {
  const self = this;

  if (!self.isRunning()) {
    return Promise.reject(Error('Application not running'));
  }

  return new Promise(function (resolve, reject) {
    const endClient = function () {
      setTimeout(function () {
        self.chromeDriver.stop();
        self.running = false;
        resolve(self);
      }, self.quitTimeout);
    };

    if (self.api.nodeIntegration) {
      self.client.electron.remote.app.quit().then(endClient, reject);
    } else {
      self.client
        .windowByIndex(0)
        .then(function () {
          self.client.closeWindow();
        })
        .then(endClient, reject);
    }
  });
};

Application.prototype.restart = function () {
  const self = this;
  return self.stop().then(function () {
    return self.start();
  });
};

Application.prototype.isRunning = function () {
  return this.running;
};

Application.prototype.getSettings = function () {
  return {
    host: this.host,
    port: this.port,
    quitTimeout: this.quitTimeout,
    startTimeout: this.startTimeout,
    waitTimeout: this.waitTimeout,
    connectionRetryCount: this.connectionRetryCount,
    connectionRetryTimeout: this.connectionRetryTimeout,
    nodePath: this.nodePath,
    path: this.path,
    args: this.args,
    chromeDriverArgs: this.chromeDriverArgs,
    env: this.env,
    workingDirectory: this.workingDirectory,
    debuggerAddress: this.debuggerAddress,
    chromeDriverLogPath: this.chromeDriverLogPath,
    webdriverLogPath: this.webdriverLogPath,
    webdriverOptions: this.webdriverOptions,
    requireName: this.requireName
  };
};

Application.prototype.exists = function () {
  const self = this;
  return new Promise(function (resolve, reject) {
    // Binary path is ignored by ChromeDriver if debuggerAddress is set
    if (self.debuggerAddress) return resolve();

    if (typeof self.path !== 'string') {
      return reject(Error('Application path must be a string'));
    }

    fs.stat(self.path, function (error, stat) {
      if (error) return reject(error);
      if (stat.isFile()) return resolve();
      reject(Error('Application path specified is not a file: ' + self.path));
    });
  });
};

Application.prototype.startChromeDriver = function () {
  this.chromeDriver = new ChromeDriver(
    this.host,
    this.port,
    this.nodePath,
    this.startTimeout,
    this.workingDirectory,
    this.chromeDriverLogPath
  );
  return this.chromeDriver.start();
};

Application.prototype.createClient = function () {
  const self = this;
  return new Promise(function (resolve, reject) {
    const args = [];
    args.push('spectron-path=' + self.path);
    self.args.forEach(function (arg, index) {
      args.push('spectron-arg' + index + '=' + arg);
    });

    for (const name in self.env) {
      if (Object.prototype.hasOwnProperty.call(self.env, name)) {
        args.push('spectron-env-' + name + '=' + self.env[name]);
      }
    }

    self.chromeDriverArgs.forEach(function (arg) {
      args.push(arg);
    });

    const isWin = process.platform === 'win32';
    const launcherPath = path.join(
      __dirname,
      isWin ? 'launcher.bat' : 'launcher.js'
    );

    if (process.env.APPVEYOR) {
      args.push('no-sandbox');
    }

    const options = {
      hostname: self.host,
      port: self.port,
      waitforTimeout: self.waitTimeout,
      connectionRetryCount: self.connectionRetryCount,
      connectionRetryTimeout: self.connectionRetryTimeout,
      logLevel: 'silent',
      capabilities: {
        'goog:chromeOptions': {
          binary: launcherPath,
          args: args,
          debuggerAddress: self.debuggerAddress,
          windowTypes: ['app', 'webview']
        }
      },
      logOutput: DevNull()
    };

    if (self.webdriverLogPath) {
      options.outputDir = self.webdriverLogPath;
      options.logLevel = 'trace';
    }

    Object.assign(options, self.webdriverOptions);

    self.client = WebDriver.remote(options).then(function (remote) {
      self.client = remote;
      self.addCommands();
      resolve();
    }, reject);
  });
};

Application.prototype.addCommands = function () {
  this.client.addCommand(
    'waitUntilTextExists',
    function (selector, text, timeout) {
      const self = this;
      return self
        .waitUntil(async function () {
          const elem = await self.$(selector);
          const exists = await elem.isExisting();
          if (!exists) {
            return false;
          }

          const selectorText = await elem.getText();
          return Array.isArray(selectorText)
            ? selectorText.some((s) => s.includes(text))
            : selectorText.includes(text);
        }, timeout)
        .then(
          function () {},
          function (error) {
            error.message = 'waitUntilTextExists ' + error.message;
            throw error;
          }
        );
    }
  );

  this.client.addCommand('waitUntilWindowLoaded', function (timeout) {
    const self = this;
    return self
      .waitUntil(function () {
        return self.webContents.isLoading().then(function (loading) {
          return !loading;
        });
      }, timeout)
      .then(
        function () {},
        function (error) {
          error.message = 'waitUntilWindowLoaded ' + error.message;
          throw error;
        }
      );
  });

  this.client.addCommand('getWindowCount', function () {
    return this.getWindowHandles().then(function (handles) {
      return handles.length;
    });
  });

  this.client.addCommand('windowByIndex', function (index) {
    const self = this;
    return self.getWindowHandles().then(function (handles) {
      return self.switchToWindow(handles[index]);
    });
  });

  this.client.addCommand('getSelectedText', function () {
    return this.execute(function () {
      return window.getSelection().toString();
    });
  });

  this.client.addCommand('getRenderProcessLogs', function () {
    return this.getLogs('browser');
  });

  const self = this;
  this.client.addCommand('getMainProcessLogs', function () {
    const logs = self.chromeDriver.getLogs();
    self.chromeDriver.clearLogs();
    return logs;
  });

  Accessibility.addCommand(this.client, this.requireName);
};

module.exports = Application;
