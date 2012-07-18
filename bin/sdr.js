#!/usr/bin/env node

var rtlsdr = require('rtlsdr');
var portAudio = require('portaudio');
var FmDecoder = require('../lib/fmDecoder');

var outputSampleRate = 44100;

run(function (err) {
  if (err) {
    console.error(err.stack);
  }
});

function run(callback) {
  var pa;

  portAudio.open({
    channelCount: 1,
    sampleFormat: portAudio.SampleFormat8Bit,
    sampleRate: outputSampleRate
  }, audioOutputOpened);

  function audioOutputOpened(err, _pa) {
    if (err) {
      return callback(err);
    }
    pa = _pa;

    rtlsdr.getDevices(function (err, devices) {
      if (err) {
        return callback(err);
      }
      if (devices.length === 0) {
        return callback(new Error("No valid devices"));
      }

      devices[0].open(sdrDeviceOpened);
    });
  }

  function sdrDeviceOpened(err, device) {
    if (err) {
      return callback(err);
    }

    var decoder = new FmDecoder(99500000);
    decoder.on("data", function (data) {
      pa.write(data);
    });

    device.on("data", function (data) {
      decoder.write(data);
    });

    device.setSampleRate(decoder.fm.captureRate);
    device.setCenterFrequency(decoder.fm.captureFreq);
    device.start();
    pa.start();
    setTimeout(function () {
      pa.stop();
      device.stop();
    }, 10000);
  }
}