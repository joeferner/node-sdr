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
    sampleFormat: portAudio.SampleFormat16Bit,
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

    var freq = 99500000;
    var decoder = new FmDecoder(freq);
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

    setInterval(function() {
      freq += 50000;
      decoder.setFrequency(freq);
      device.setCenterFrequency(decoder.fm.captureFreq);
      console.log(decoder.fm.captureFreq);
    }, 1000);

    setTimeout(function () {
      pa.stop();
      device.stop();
    }, 30000);
  }
}