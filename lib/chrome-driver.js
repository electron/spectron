const ChildProcess = require('child_process');
const path = require('path');
const { default: got } = require('got');
const split = require('split');

function delay(duration) {
  return new Promise((resolve) => global.setTimeout(resolve, duration));
}

function ChromeDriver(
  host,
  port,
  nodePath,
  startTimeout,
  workingDirectory,
  chromeDriverLogPath
) {
  this.host = host;
  this.port = port;
  this.nodePath = nodePath;
  this.startTimeout = startTimeout;
  this.workingDirectory = workingDirectory;
  this.chromeDriverLogPath = chromeDriverLogPath;

  this.path = require.resolve('electron-chromedriver/chromedriver');
  this.urlBase = '/';
  this.statusUrl = `http://${this.host}:${this.port}${this.urlBase}status`;
  this.logLines = [];
}

ChromeDriver.prototype.start = function () {
  if (this.process) throw new Error('ChromeDriver already started');

  const args = [this.path, `--port=${this.port}`, `--url-base=${this.urlBase}`];

  if (this.chromeDriverLogPath) {
    args.push('--verbose');
    args.push(`--log-path=${this.chromeDriverLogPath}`);
  }
  const options = {
    cwd: this.workingDirectory,
    env: this.getEnvironment()
  };
  this.process = ChildProcess.spawn(this.nodePath, args, options);

  const self = this;
  this.exitHandler = function () {
    self.stop();
  };
  global.process.on('exit', this.exitHandler);

  this.setupLogs();
  return this.waitUntilRunning();
};

ChromeDriver.prototype.waitUntilRunning = async function () {
  const startTime = Date.now();
  for (;;) {
    const isRunning = await this.isRunning();

    if (!this.process) {
      throw new Error('ChromeDriver has been stopped');
    }

    // if (this.process.exitCode !== null) {
    //   throw new Error(`ChromeDriver exited with code ${this.process.exitCode}`);
    // }

    if (isRunning) {
      return;
    }

    const elapsedTime = Date.now() - startTime;
    if (elapsedTime > this.startTimeout) {
      throw new Error(
        `ChromeDriver did not start within ${this.startTimeout}ms`
      );
    }

    await delay(100);
  }
};

ChromeDriver.prototype.setupLogs = function () {
  const linesToIgnore = 2; // First two lines are ChromeDriver specific
  let lineCount = 0;

  this.logLines = [];

  const self = this;
  this.process.stdout.pipe(split()).on('data', function (line) {
    if (lineCount < linesToIgnore) {
      lineCount++;
      return;
    }
    self.logLines.push(line);
  });
};

ChromeDriver.prototype.getEnvironment = function () {
  const env = {};
  Object.keys(process.env).forEach(function (key) {
    env[key] = process.env[key];
  });

  if (process.platform === 'win32') {
    env.SPECTRON_NODE_PATH = process.execPath;
    env.SPECTRON_LAUNCHER_PATH = path.join(__dirname, 'launcher.js');
  }

  return env;
};

ChromeDriver.prototype.stop = function () {
  if (this.exitHandler) global.process.removeListener('exit', this.exitHandler);
  this.exitHandler = null;

  if (this.process) this.process.kill();
  this.process = null;

  this.clearLogs();
};

ChromeDriver.prototype.isRunning = async function () {
  try {
    const { value } = await got(this.statusUrl).json();
    return value && value.ready;
  } catch (err) {
    console.log('err', err);
    return false;
  }
};

ChromeDriver.prototype.getLogs = function () {
  return this.logLines.slice();
};

ChromeDriver.prototype.clearLogs = function () {
  this.logLines = [];
};

module.exports = ChromeDriver;
