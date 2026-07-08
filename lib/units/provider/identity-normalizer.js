var childProcess = require('child_process')
var fs = require('fs')
var path = require('path')

var Promise = require('bluebird')

module.exports = function(options, log) {
  var state = readState()
  var repairing = Object.create(null)

  function enabled() {
    return options.duplicateSerialFix !== false
  }

  function adb(args) {
    var adbArgs = []

    if (options.adbHost) {
      adbArgs.push('-H', options.adbHost)
    }

    if (options.adbPort) {
      adbArgs.push('-P', String(options.adbPort))
    }

    adbArgs = adbArgs.concat(args)

    return new Promise(function(resolve, reject) {
      childProcess.execFile('adb', adbArgs, {
        maxBuffer: 1024 * 1024
      }, function(err, stdout, stderr) {
        if (err) {
          err.stdout = stdout
          err.stderr = stderr
          reject(err)
        }
        else {
          resolve(String(stdout || '').replace(/\r/g, ''))
        }
      })
    })
  }

  function adbTransport(transportId, args) {
    return adb(['-t', String(transportId)].concat(args))
  }

  function readState() {
    var stateFile = options.duplicateSerialStateFile

    if (!stateFile) {
      return {
        assignments: {}
      }
    }

    try {
      var parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      parsed.assignments = parsed.assignments || {}
      return parsed
    }
    catch (err) {
      return {
        assignments: {}
      }
    }
  }

  function writeState() {
    var stateFile = options.duplicateSerialStateFile

    if (!stateFile) {
      return
    }

    try {
      fs.mkdirSync(path.dirname(stateFile), {
        recursive: true
      })
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
    }
    catch (err) {
      log.warn(
        'Unable to persist duplicate serial state to "%s": %s'
      , stateFile
      , err.message
      )
      log.warn('Continuing with in-memory duplicate serial assignments')
    }
  }

  function parseDevices(output) {
    return output.split('\n').reduce(function(devices, line) {
      var match = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/)

      if (!match || match[1] === 'List') {
        return devices
      }

      var details = match[3] || ''
      var transportMatch = details.match(/(?:^|\s)transport_id:(\S+)/)
      var usbMatch = details.match(/(?:^|\s)usb:(\S+)/)

      devices.push({
        serial: match[1]
      , state: match[2]
      , transportId: transportMatch && transportMatch[1]
      , usbPath: usbMatch && usbMatch[1]
      })

      return devices
    }, [])
  }

  function listDevices() {
    return adb(['devices', '-l'])
      .then(parseDevices)
  }

  function findDeviceBySerial(serial) {
    return listDevices()
      .then(function(devices) {
        return devices.filter(function(device) {
          return device.serial === serial && device.state === 'device'
        })
      })
  }

  function findTransportByKey(key) {
    return listDevices()
      .then(function(devices) {
        var found = devices.filter(function(device) {
          return device.state === 'device' &&
            device.usbPath === key
        })[0]

        return found && found.transportId
      })
  }

  function shell(transportId, command) {
    return adbTransport(transportId, ['shell', command])
  }

  function getprop(transportId, prop) {
    return shell(transportId, 'getprop ' + prop)
      .then(function(value) {
        return value.trim()
      })
  }

  function readIdentity(transportId) {
    return Promise.props({
      hardware: getprop(transportId, 'ro.boot.hardware').catch(function() {
        return ''
      })
    , legacyHardware: getprop(transportId, 'ro.hardware').catch(function() {
        return ''
      })
    , platform: getprop(transportId, 'ro.board.platform').catch(function() {
        return ''
      })
    , manufacturer: getprop(transportId, 'ro.soc.manufacturer').catch(function() {
        return ''
      })
    })
  }

  function isMtkIdentity(identity) {
    return [
      identity.hardware
    , identity.legacyHardware
    , identity.platform
    , identity.manufacturer
    ].join('\n').match(/mt[0-9]|mediatek/i)
  }

  function serialInUse(serial) {
    return Object.keys(state.assignments).some(function(key) {
      return state.assignments[key].serial === serial
    })
  }

  function nextSerial() {
    var prefix = options.duplicateSerialPrefix || 'MTKADB'
    var width = options.duplicateSerialWidth || 3
    var limit = options.duplicateSerialLimit || 9999
    var i, serial

    for (i = 1; i <= limit; ++i) {
      serial = prefix + String(i).padStart(width, '0')
      if (!serialInUse(serial)) {
        return serial
      }
    }

    throw new Error('No duplicate serial assignments left')
  }

  function assignmentFor(key, identity) {
    if (state.assignments[key]) {
      return state.assignments[key].serial
    }

    state.assignments[key] = {
      serial: nextSerial()
    , createdAt: new Date().toISOString()
    , identity: identity
    }

    writeState()
    return state.assignments[key].serial
  }

  function waitForTransportKey(key) {
    return Promise.resolve()
      .then(function retry() {
        return findTransportByKey(key)
          .then(function(transportId) {
            if (transportId) {
              return transportId
            }

            return Promise.delay(1000).then(retry)
          })
      })
      .timeout(20000)
  }

  function ensureRoot(transportId, key) {
    return shell(transportId, 'id -u')
      .then(function(uid) {
        if (uid.trim() === '0') {
          return transportId
        }

        return adbTransport(transportId, ['root'])
          .catch(function() {
            return true
          })
          .then(function() {
            return waitForTransportKey(key)
          })
          .then(function(rootTransportId) {
            return shell(rootTransportId, 'id -u')
              .then(function(rootUid) {
                if (rootUid.trim() !== '0') {
                  throw new Error('Device is not root after adb root')
                }

                return rootTransportId
              })
          })
      })
  }

  function waitForSerial(serial) {
    return Promise.resolve()
      .then(function retry() {
        return listDevices()
          .then(function(devices) {
            var found = devices.some(function(device) {
              return device.serial === serial && device.state === 'device'
            })

            if (found) {
              return true
            }

            return Promise.delay(1000).then(retry)
          })
      })
      .timeout(20000)
  }

  function safeSerial(serial) {
    if (!serial.match(/^[A-Za-z0-9._-]+$/)) {
      throw new Error('Unsafe generated serial: ' + serial)
    }

    return serial
  }

  function repair(transportId, key, targetSerial) {
    var serial = safeSerial(targetSerial)

    return ensureRoot(transportId, key)
      .then(function(rootTransportId) {
        return shell(
          rootTransportId
        , 'test -w /config/usb_gadget/g1/strings/0x409/serialnumber'
        )
          .then(function() {
            return shell(
              rootTransportId
            , 'echo ' + serial + ' > ' +
              '/config/usb_gadget/g1/strings/0x409/serialnumber'
            )
          })
          .then(function() {
            return shell(
              rootTransportId
            , 'setprop persist.vendor.serialno ' + serial
            ).catch(function() {
              return true
            })
          })
          .then(function() {
            return shell(rootTransportId, 'setprop ctl.restart adbd')
          })
      })
      .then(function() {
        return waitForSerial(serial)
      })
  }

  function normalize(device) {
    var duplicateSerial = options.duplicateSerialValue || '0123456789ABCDEF'

    if (!enabled() || device.id !== duplicateSerial || device.type !== 'device') {
      return Promise.resolve(false)
    }

    if (repairing[device.id]) {
      log.info(
        'Suppressing duplicate serial "%s" while normalization is in progress'
      , device.id
      )
      return Promise.resolve(true)
    }

    repairing[device.id] = true

    return findDeviceBySerial(device.id)
      .then(function(devices) {
        return Promise.map(devices, function(found) {
          var key = found.usbPath

          if (!found.transportId) {
            log.warn(
              'Cannot normalize duplicate serial "%s"; missing transport_id'
            , found.serial
            )
            return false
          }

          if (!key) {
            log.warn(
              'Cannot normalize duplicate serial "%s"; missing USB path'
            , found.serial
            )
            return false
          }

          return readIdentity(found.transportId)
            .then(function(identity) {
              if (options.duplicateSerialRequireMtk !== false &&
                  !isMtkIdentity(identity)) {
                log.warn(
                  'Skipping duplicate serial "%s" at "%s"; device is not MTK'
                , found.serial
                , key
                )
                return false
              }

              var targetSerial = assignmentFor(key, identity)

              log.info(
                'Normalizing duplicate serial "%s" at "%s" to "%s"'
              , found.serial
              , key
              , targetSerial
              )

              return repair(found.transportId, key, targetSerial)
                .then(function() {
                  log.info(
                    'Normalized duplicate serial "%s" at "%s" to "%s"'
                  , found.serial
                  , key
                  , targetSerial
                  )
                  return true
                })
            })
        }, {
          concurrency: 1
        })
      })
      .catch(function(err) {
        log.error(
          'Duplicate serial normalization failed for "%s": %s'
        , device.id
        , err.message
        )
      })
      .finally(function() {
        delete repairing[device.id]
      })
      .then(function() {
        return true
      })
  }

  return {
    normalize: normalize
  }
}
