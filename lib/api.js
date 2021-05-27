const apiCache = {};

function Api(app, requireName) {
  this.app = app;
  this.requireName = requireName;
}

Api.prototype.initialize = function () {
  const self = this;
  return self.load().then(self.addApiCommands.bind(self));
};

Api.prototype.addApiCommands = function (api) {
  if (!this.nodeIntegration) return;

  this.addRenderProcessApis(api.electron);
  this.addMainProcessApis(api.electron.remote);
  this.addBrowserWindowApis(api.browserWindow);
  this.addWebContentsApis(api.webContents);
  this.addProcessApis(api.rendererProcess);

  this.api = {
    browserWindow: api.browserWindow,
    electron: api.electron,
    rendererProcess: api.rendererProcess,
    webContents: api.webContents
  };

  this.addClientProperties();
};

Api.prototype.load = function () {
  const self = this;

  return this.isNodeIntegrationEnabled().then(function (nodeIntegration) {
    self.nodeIntegration = nodeIntegration;
    if (!nodeIntegration) {
      return {
        electron: { remote: {} },
        browserWindow: {},
        webContents: {},
        rendererProcess: {}
      };
    }

    return self.getVersion().then(function (version) {
      const api = apiCache[version];
      if (api) return api;

      return self.loadApi().then(function (api) {
        if (version) apiCache[version] = api;
        return api;
      });
    });
  });
};

Api.prototype.isNodeIntegrationEnabled = function () {
  const self = this;
  return self.app.client.execute(function (requireName) {
    return typeof window[requireName] === 'function';
  }, self.requireName);
};

Api.prototype.getVersion = function () {
  return this.app.client.execute(function (requireName) {
    const process = window[requireName]('process');
    if (process != null && process.versions != null) {
      return process.versions.electron;
    }
  }, this.requireName);
};

Api.prototype.loadApi = function () {
  return this.app.client.execute(function (requireName) {
    if (typeof window[requireName] !== 'function') {
      throw new Error(
        'Could not find global require method with name: ' + requireName
      );
    }
    const electron = window[requireName]('electron');
    const process = window[requireName]('process');

    const api = {
      browserWindow: {},
      electron: {},
      rendererProcess: {},
      webContents: {}
    };

    function ignoreModule(moduleName) {
      switch (moduleName) {
        case 'CallbacksRegistry':
        case 'deprecate':
        case 'deprecations':
        case 'hideInternalModules':
        case 'Tray':
          return true;
        case 'inAppPurchase':
          return process.platform !== 'darwin';
      }
      return false;
    }

    function isRemoteFunction(name) {
      switch (name) {
        case 'BrowserWindow':
        case 'Menu':
        case 'MenuItem':
          return false;
      }
      return typeof electron.remote[name] === 'function';
    }

    function ignoreApi(apiName) {
      switch (apiName) {
        case 'prototype':
          return true;
        default:
          return apiName[0] === '_';
      }
    }

    function addModule(parent, parentName, name, api) {
      api[name] = {};
      for (const key in parent[name]) {
        if (ignoreApi(key)) continue;
        api[name][key] = parentName + '.' + name + '.' + key;
      }
    }

    function addRenderProcessModules() {
      Object.getOwnPropertyNames(electron).forEach(function (key) {
        if (ignoreModule(key)) return;
        if (key === 'remote') return;
        addModule(electron, 'electron', key, api.electron);
      });
    }

    function addMainProcessModules() {
      api.electron.remote = {};
      if (typeof electron.remote !== 'object') return;
      Object.getOwnPropertyNames(electron.remote).forEach(function (key) {
        if (ignoreModule(key)) return;
        if (isRemoteFunction(key)) {
          api.electron.remote[key] = 'electron.remote.' + key;
        } else {
          addModule(
            electron.remote,
            'electron.remote',
            key,
            api.electron.remote
          );
        }
      });
      addModule(
        electron.remote,
        'electron.remote',
        'process',
        api.electron.remote
      );
    }

    function addBrowserWindow() {
      if (typeof electron.remote !== 'object') return;
      const currentWindow = electron.remote.getCurrentWindow();
      for (const name in currentWindow) {
        if (ignoreApi(name)) continue;
        const value = currentWindow[name];
        if (typeof value === 'function') {
          api.browserWindow[name] = 'browserWindow.' + name;
        }
      }
    }

    function addWebContents() {
      if (typeof electron.remote !== 'object') return;
      const webContents = electron.remote.getCurrentWebContents();
      for (const name in webContents) {
        if (ignoreApi(name)) continue;
        const value = webContents[name];
        if (typeof value === 'function') {
          api.webContents[name] = 'webContents.' + name;
        }
      }
    }

    function addProcess() {
      if (typeof process !== 'object') return;

      for (const name in process) {
        if (ignoreApi(name)) continue;
        api.rendererProcess[name] = 'process.' + name;
      }
    }

    addRenderProcessModules();
    addMainProcessModules();
    addBrowserWindow();
    addWebContents();
    addProcess();

    return api;
  }, this.requireName);
};

Api.prototype.addClientProperty = function (name) {
  const self = this;

  const clientPrototype = Object.getPrototypeOf(self.app.client);
  Object.defineProperty(clientPrototype, name, {
    get: function () {
      const client = this;
      return transformObject(self.api[name], {}, function (value) {
        return client[value].bind(client);
      });
    }
  });
};

Api.prototype.addClientProperties = function () {
  this.addClientProperty('electron');
  this.addClientProperty('browserWindow');
  this.addClientProperty('webContents');
  this.addClientProperty('rendererProcess');

  Object.defineProperty(Object.getPrototypeOf(this.app.client), 'mainProcess', {
    get: function () {
      return this.electron.remote.process;
    }
  });
};

Api.prototype.addRenderProcessApis = function (api) {
  const app = this.app;
  const self = this;
  const electron = {};
  app.electron = electron;

  Object.keys(api).forEach(function (moduleName) {
    if (moduleName === 'remote') return;
    electron[moduleName] = {};
    const moduleApi = api[moduleName];

    Object.keys(moduleApi).forEach(function (key) {
      const commandName = moduleApi[key];

      app.client.addCommand(commandName, function () {
        const args = Array.prototype.slice.call(arguments);
        return this.execute(
          callRenderApi,
          moduleName,
          key,
          args,
          self.requireName
        );
      });

      electron[moduleName][key] = function () {
        return app.client[commandName].apply(app.client, arguments);
      };
    });
  });
};

Api.prototype.addMainProcessApis = function (api) {
  const app = this.app;
  const self = this;
  const remote = {};
  app.electron.remote = remote;

  Object.keys(api)
    .filter(function (propertyName) {
      return typeof api[propertyName] === 'string';
    })
    .forEach(function (name) {
      const commandName = api[name];

      app.client.addCommand(commandName, function () {
        const args = Array.prototype.slice.call(arguments);
        return this.execute(callMainApi, '', name, args, self.requireName);
      });

      remote[name] = function () {
        return app.client[commandName].apply(app.client, arguments);
      };
    });

  Object.keys(api)
    .filter(function (moduleName) {
      return typeof api[moduleName] === 'object';
    })
    .forEach(function (moduleName) {
      remote[moduleName] = {};
      const moduleApi = api[moduleName];

      Object.keys(moduleApi).forEach(function (key) {
        const commandName = moduleApi[key];

        app.client.addCommand(commandName, function () {
          const args = Array.prototype.slice.call(arguments);
          return this.execute(
            callMainApi,
            moduleName,
            key,
            args,
            self.requireName
          );
        });

        remote[moduleName][key] = function () {
          return app.client[commandName].apply(app.client, arguments);
        };
      });
    });
};

Api.prototype.addBrowserWindowApis = function (api) {
  const app = this.app;
  const self = this;
  app.browserWindow = {};

  const asyncApis = {
    'browserWindow.capturePage': true
  };

  Object.keys(api)
    .filter(function (name) {
      return !Object.prototype.hasOwnProperty.call(asyncApis, api[name]);
    })
    .forEach(function (name) {
      const commandName = api[name];

      app.client.addCommand(commandName, function () {
        const args = Array.prototype.slice.call(arguments);
        return this.execute(callBrowserWindowApi, name, args, self.requireName);
      });

      app.browserWindow[name] = function () {
        return app.client[commandName].apply(app.client, arguments);
      };
    });

  this.addCapturePageSupport();
};

Api.prototype.addCapturePageSupport = function () {
  const app = this.app;
  const self = this;

  app.client.addCommand('browserWindow.capturePage', function (rect) {
    return this.executeAsync(
      async function (rect, requireName, done) {
        const args = [];
        if (rect != null) args.push(rect);
        const browserWindow = window[requireName](
          'electron'
        ).remote.getCurrentWindow();
        const image = await browserWindow.capturePage.apply(
          browserWindow,
          args
        );
        if (image != null) {
          done(image.toPNG().toString('base64'));
        } else {
          done(image);
        }
      },
      rect,
      self.requireName
    ).then(function (image) {
      return Buffer.from(image, 'base64');
    });
  });

  app.browserWindow.capturePage = function () {
    return app.client['browserWindow.capturePage'].apply(app.client, arguments);
  };
};

Api.prototype.addWebContentsApis = function (api) {
  const app = this.app;
  const self = this;
  app.webContents = {};

  const asyncApis = {
    'webContents.savePage': true,
    'webContents.executeJavaScript': true
  };

  Object.keys(api)
    .filter(function (name) {
      return !Object.prototype.hasOwnProperty.call(asyncApis, api[name]);
    })
    .forEach(function (name) {
      const commandName = api[name];

      app.client.addCommand(commandName, function () {
        const args = Array.prototype.slice.call(arguments);
        return this.execute(callWebContentsApi, name, args, self.requireName);
      });

      app.webContents[name] = function () {
        return app.client[commandName].apply(app.client, arguments);
      };
    });

  this.addSavePageSupport();
  this.addExecuteJavaScriptSupport();
};

Api.prototype.addSavePageSupport = function () {
  const app = this.app;
  const self = this;

  app.client.addCommand('webContents.savePage', function (fullPath, saveType) {
    return this.executeAsync(
      async function (fullPath, saveType, requireName, done) {
        const webContents = window[requireName](
          'electron'
        ).remote.getCurrentWebContents();
        await webContents.savePage(fullPath, saveType);
        done();
      },
      fullPath,
      saveType,
      self.requireName
    ).then(function (rawError) {
      if (rawError) {
        const error = new Error(rawError.message);
        if (rawError.name) error.name = rawError.name;
        throw error;
      }
    });
  });

  app.webContents.savePage = function () {
    return app.client['webContents.savePage'].apply(app.client, arguments);
  };
};

Api.prototype.addExecuteJavaScriptSupport = function () {
  const app = this.app;
  const self = this;

  app.client.addCommand(
    'webContents.executeJavaScript',
    function (code, useGesture) {
      return this.executeAsync(
        async function (code, useGesture, requireName, done) {
          const webContents = window[requireName](
            'electron'
          ).remote.getCurrentWebContents();
          const result = await webContents.executeJavaScript(code, useGesture);
          done(result);
        },
        code,
        useGesture,
        self.requireName
      );
    }
  );

  app.webContents.executeJavaScript = function () {
    return app.client['webContents.executeJavaScript'].apply(
      app.client,
      arguments
    );
  };
};

Api.prototype.addProcessApis = function (api) {
  const app = this.app;
  app.rendererProcess = {};

  Object.keys(api).forEach(function (name) {
    const commandName = api[name];

    app.client.addCommand(commandName, function () {
      const args = Array.prototype.slice.call(arguments);
      return this.execute(callProcessApi, name, args);
    });

    app.rendererProcess[name] = function () {
      return app.client[commandName].apply(app.client, arguments);
    };
  });

  app.mainProcess = app.electron.remote.process;
};

Api.prototype.transferPromiseness = function (target, promise) {
  if (!this.nodeIntegration) return;

  const addProperties = function (source, target, moduleName) {
    const sourceModule = source[moduleName];
    if (!sourceModule) return;
    target[moduleName] = transformObject(
      sourceModule,
      {},
      function (value, parent) {
        return value.bind(parent);
      }
    );
  };

  addProperties(promise, target, 'webContents');
  addProperties(promise, target, 'browserWindow');
  addProperties(promise, target, 'electron');
  addProperties(promise, target, 'mainProcess');
  addProperties(promise, target, 'rendererProcess');
};

Api.prototype.logApi = function () {
  const fs = require('fs');
  const path = require('path');
  const json = JSON.stringify(this.api, null, 2);
  fs.writeFileSync(path.join(__dirname, 'api.json'), json);
};

function transformObject(input, output, callback) {
  Object.keys(input).forEach(function (name) {
    const value = input[name];
    if (typeof value === 'object') {
      output[name] = {};
      transformObject(value, output[name], callback);
    } else {
      output[name] = callback(value, input);
    }
  });
  return output;
}

function callRenderApi(moduleName, api, args, requireName) {
  const module = window[requireName]('electron')[moduleName];
  if (typeof module[api] === 'function') {
    return module[api].apply(module, args);
  } else {
    return module[api];
  }
}

function callMainApi(moduleName, api, args, requireName) {
  let module = window[requireName]('electron').remote;
  if (moduleName) {
    module = module[moduleName];
  }
  if (typeof module[api] === 'function') {
    return module[api].apply(module, args);
  } else {
    return module[api];
  }
}

function callWebContentsApi(name, args, requireName) {
  const webContents = window[requireName](
    'electron'
  ).remote.getCurrentWebContents();
  return webContents[name].apply(webContents, args);
}

function callBrowserWindowApi(name, args, requireName) {
  const browserWindow = window[requireName](
    'electron'
  ).remote.getCurrentWindow();
  return browserWindow[name].apply(browserWindow, args);
}

function callProcessApi(name, args) {
  if (typeof process[name] === 'function') {
    return process[name].apply(process, args);
  } else {
    return process[name];
  }
}

module.exports = Api;
