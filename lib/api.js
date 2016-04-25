function Api (app) {
  this.app = app
}

Api.prototype.initialize = function () {
  var self = this
  return this.load(self.app).then(function (api) {
    self.addRenderProcessApis(api.render)
    self.addMainProcessApis(api.main)
    self.addBrowserWindowApis(api.browserWindow)
    self.addWebContentsApis(api.webContents)
    self.addProcessApis(api.process)

    self.api = {
      browserWindow: api.browserWindow,
      electron: api.render,
      rendererProcess: api.process,
      webContents: api.webContents
    }
    self.api.electron.remote = api.main

    self.addClientProperties()
  })
}

Api.prototype.load = function (app) {
  return app.client.execute(function () {
    var electron = require('electron')

    var api = {
      browserWindow: {},
      main: {},
      process: {},
      render: {},
      webContents: {}
    }

    function ignoreModule (moduleName) {
      switch (moduleName) {
        case 'CallbacksRegistry':
        case 'deprecate':
        case 'deprecations':
        case 'hideInternalModules':
          return true
      }
      return false
    }

    function ignoreApi (apiName) {
      switch (apiName) {
        case 'prototype':
          return true
        default:
          return apiName[0] === '_'
      }
    }

    function addModule (parent, parentName, name, api) {
      api[name] = {}
      Object.getOwnPropertyNames(parent[name]).forEach(function (key) {
        if (ignoreApi(key)) return
        api[name][key] = parentName + '.' + name + '.' + key
      })
    }

    function addRenderProcessModules () {
      Object.getOwnPropertyNames(electron).forEach(function (key) {
        if (ignoreModule(key)) return
        if (key === 'remote') return
        addModule(electron, 'electron', key, api.render)
      })
    }

    function addMainProcessModules () {
      Object.getOwnPropertyNames(electron.remote).forEach(function (key) {
        if (ignoreModule(key)) return
        addModule(electron.remote, 'electron.remote', key, api.main)
      })
      addModule(electron.remote, 'electron.remote', 'process', api.main)
    }

    function addBrowserWindow () {
      var currentWindow = electron.remote.getCurrentWindow()
      for (var name in currentWindow) {
        var value = currentWindow[name]
        if (typeof value === 'function') {
          api.browserWindow[name] = 'browserWindow.' + name
        }
      }
    }

    function addWebContents () {
      var webContents = electron.remote.getCurrentWebContents()
      for (var name in webContents) {
        var value = webContents[name]
        if (typeof value === 'function') {
          api.webContents[name] = 'webContents.' + name
        }
      }
    }

    function addProcess () {
      for (var name in process) {
        if (ignoreApi(name)) continue
        api.process[name] = 'process.' + name
      }
    }

    addRenderProcessModules()
    addMainProcessModules()
    addBrowserWindow()
    addWebContents()
    addProcess()

    return api
  }).then(getResponseValue)
}

Api.prototype.addClientProperty = function (name) {
  var self = this

  var clientPrototype = Object.getPrototypeOf(self.app.client)
  Object.defineProperty(clientPrototype, name, {
    get: function () {
      var client = this
      return transformObject(self.api[name], {}, function (value) {
        return client[value].bind(client)
      })
    }
  })
}

Api.prototype.addClientProperties = function () {
  this.addClientProperty('electron')
  this.addClientProperty('browserWindow')
  this.addClientProperty('webContents')
  this.addClientProperty('rendererProcess')

  Object.defineProperty(Object.getPrototypeOf(this.app.client), 'mainProcess', {
    get: function () {
      return this.electron.remote.process
    }
  })
}

Api.prototype.addRenderProcessApis = function (api) {
  var app = this.app
  var electron = {}
  app.electron = electron

  Object.keys(api).forEach(function (moduleName) {
    electron[moduleName] = {}
    var moduleApi = api[moduleName]

    Object.keys(moduleApi).forEach(function (key) {
      var commandName = moduleApi[key]

      app.client.addCommand(commandName, function () {
        var args = Array.prototype.slice.call(arguments)
        return this.execute(callRenderApi, moduleName, key, args).then(getResponseValue)
      })

      electron[moduleName][key] = function () {
        return app.client[commandName].apply(app.client, arguments)
      }
    })
  })
}

Api.prototype.addMainProcessApis = function (api) {
  var app = this.app
  var remote = {}
  app.electron.remote = remote

  Object.keys(api).forEach(function (moduleName) {
    remote[moduleName] = {}
    var moduleApi = api[moduleName]

    Object.keys(moduleApi).forEach(function (key) {
      var commandName = moduleApi[key]

      app.client.addCommand(commandName, function () {
        var args = Array.prototype.slice.call(arguments)
        return this.execute(callMainApi, moduleName, key, args).then(getResponseValue)
      })

      remote[moduleName][key] = function () {
        return app.client[commandName].apply(app.client, arguments)
      }
    })
  })
}

Api.prototype.addBrowserWindowApis = function (api) {
  var app = this.app
  app.browserWindow = {}

  Object.keys(api).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callBrowserWindowApi, name, args).then(getResponseValue)
    })

    app.browserWindow[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })
}

Api.prototype.addWebContentsApis = function (api) {
  var app = this.app
  app.webContents = {}

  Object.keys(api).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callWebContentsApi, name, args).then(getResponseValue)
    })

    app.webContents[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })
}

Api.prototype.addProcessApis = function (api) {
  var app = this.app
  app.rendererProcess = {}

  Object.keys(api).forEach(function (name) {
    var commandName = api[name]

    app.client.addCommand(commandName, function () {
      var args = Array.prototype.slice.call(arguments)
      return this.execute(callProcessApi, name, args).then(getResponseValue)
    })

    app.rendererProcess[name] = function () {
      return app.client[commandName].apply(app.client, arguments)
    }
  })

  app.mainProcess = app.electron.remote.process
}

Api.prototype.transferPromiseness = function (target, promise) {
  this.app.client.transferPromiseness(target, promise)

  var addProperties = function (source, target, moduleName) {
    target[moduleName] = transformObject(source[moduleName], {}, function (value, parent) {
      return value.bind(parent)
    })
  }

  addProperties(promise, target, 'webContents')
  addProperties(promise, target, 'browserWindow')
  addProperties(promise, target, 'electron')
  addProperties(promise, target, 'mainProcess')
  addProperties(promise, target, 'rendererProcess')
}

function transformObject (input, output, callback) {
  Object.keys(input).forEach(function (name) {
    var value = input[name]
    if (typeof value === 'object') {
      output[name] = {}
      transformObject(value, output[name], callback)
    } else {
      output[name] = callback(value, input)
    }
  })
  return output
}

function callRenderApi (moduleName, api, args) {
  var module = require('electron')[moduleName]
  if (typeof module[api] === 'function') {
    return module[api].apply(module, args)
  } else {
    return module[api]
  }
}

function callMainApi (moduleName, api, args) {
  var module = require('electron').remote[moduleName]
  if (typeof module[api] === 'function') {
    return module[api].apply(module, args)
  } else {
    return module[api]
  }
}

function callWebContentsApi (name, args) {
  var webContents = require('electron').remote.getCurrentWebContents()
  return webContents[name].apply(webContents, args)
}

function callBrowserWindowApi (name, args) {
  var window = require('electron').remote.getCurrentWindow()
  return window[name].apply(window, args)
}

function callProcessApi (name, args) {
  if (typeof process[name] === 'function') {
    return process[name].apply(process, args)
  } else {
    return process[name]
  }
}

function getResponseValue (response) {
  return response.value
}

module.exports = Api