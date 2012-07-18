'use strict';

var util = require("util");
var events = require("events");

var FmDecoder = module.exports = function (freq) {
  events.EventEmitter.call(this);
  this.fm = getOptimalSettings(freq);
  buildFir(this.fm);
};
util.inherits(FmDecoder, events.EventEmitter);

FmDecoder.prototype.write = function (data) {
  var sr, freqNext;
  rotate90(data);
  if (this.fm.firEnable) {
    lowPassFir(this.fm, data);
  } else {
    lowPass(this.fm, data);
  }
  fmDemod(this.fm);
  // TODO squelch: sr = postSquelch(this.fm);
  if (this.fm.postDownSample > 1) {
    this.fm.signalLen = lowPassSimple(this.fm.signal2, this.fm.signalLen, this.fm.postDownSample);
  }

  /* ignore under runs for now */
  for (var i = 0; i < this.fm.signalLen; i++) {
    this.fm.emitData[i] = this.fm.signal2[i * 2] / 255;
  }
  this.emit("data", this.fm.emitData.slice(0, this.fm.signalLen));
};

function getOptimalSettings(freq) {
  //int r, capture_freq, capture_rate;
  var fm = {};

  fm.freq = freq;
  fm.sampleRate = 24000;
  fm.squelchLevel = 0;
  fm.edge = 0;
  fm.firEnable = false;
  fm.prevIndex = -1;
  fm.postDownSample = 1;
  fm.customAtan = false;
  fm.fir = [];

  /* 16 bit signed i/q pairs */
  fm.signal = new Array(1 * 16384);

  /* signal has lowpass, signal2 has demod */
  fm.signal2 = new Array(1 * 16384);

  fm.emitData = new Buffer(1 * 16384);

  /* double sample_rate to limit to Δθ to ±π */
  fm.sampleRate *= fm.postDownSample;

  fm.downSample = (1000000 / fm.sampleRate) + 1;
  fm.captureRate = fm.downSample * fm.sampleRate;
  fm.captureFreq = fm.freq + fm.captureRate / 4;
  fm.captureFreq += fm.edge * fm.sampleRate / 2;
  fm.outputScale = (1 << 15) / (128 * fm.downSample);
  if (fm.outputScale < 1) {
    fm.outputScale = 1;
  }
  fm.outputScale = 1;

  return fm;
}

/* for now, a simple triangle
 * fancy FIRs are equally expensive, so use one */
/* point = sum(sample[i] * fir[i] * fir_len / fir_sum) */
function buildFir(fm) {
  var i, len;
  len = fm.downSample;
  for (i = 0; i < len; i++) {
    fm.fir[i] = i;
  }
  for (i = len - 1; i <= 0; i--) {
    fm.fir[i] = len - i;
  }
  fm.firSum = 0;
  for (i = 0; i < len; i++) {
    fm.firSum += fm.fir[i];
  }
}

/* 90 rotation is 1+0j, 0+1j, -1+0j, 0-1j
 or [0, 1, -3, 2, -4, -5, 7, -6] */
function rotate90(buf) {
  var i;
  var tmp;
  for (i = 0; i < buf.length; i += 8) {
    /* var negation = 255 - x */
    tmp = 255 - buf[i + 3];
    buf[i + 3] = buf[i + 2];
    buf[i + 2] = tmp;

    buf[i + 4] = 255 - buf[i + 4];
    buf[i + 5] = 255 - buf[i + 5];

    tmp = 255 - buf[i + 6];
    buf[i + 6] = buf[i + 7];
    buf[i + 7] = tmp;
  }
}

/* simple square window FIR */
function lowPass(fm, buf) {
  var i = 0, i2 = 0;
  while (i < buf.length) {
    fm.nowR += (buf[i] - 128);
    fm.nowJ += (buf[i + 1] - 128);
    i += 2;
    fm.prevIndex++;
    if (fm.prevIndex < (fm.downSample)) {
      continue;
    }
    fm.signal[i2] = fm.nowR * fm.outputScale;
    fm.signal[i2 + 1] = fm.nowJ * fm.outputScale;
    fm.prevIndex = -1;
    fm.nowR = 0;
    fm.nowJ = 0;
    i2 += 2;
  }
  fm.signalLen = i2;
}

function fmDemod(fm) {
  var i, pcm;
  pcm = polarDiscriminant(fm.signal[0], fm.signal[1], fm.preR, fm.preJ);
  fm.signal2[0] = pcm & 0xffff;
  for (i = 2; i < (fm.signalLen); i += 2) {
    if (fm.customAtan) {
      pcm = polarDiscFast(fm.signal[i], fm.signal[i + 1], fm.signal[i - 2], fm.signal[i - 1]);
    } else {
      pcm = polarDiscriminant(fm.signal[i], fm.signal[i + 1], fm.signal[i - 2], fm.signal[i - 1]);
    }
    fm.signal2[i / 2] = pcm & 0xffff;
  }
  fm.preR = fm.signal[fm.signalLen - 2];
  fm.preJ = fm.signal[fm.signalLen - 1];
}

/* returns true for active signal, false for no signal */
function postSquelch(fm) {
  var i, devR, devJ, len, sqL;
  /* only for small samples, big samples need chunk processing */
  len = fm.signalLen;
  sqL = fm.squelchLevel;
  devR = mad(fm.signal, 0, len, 2);
  devJ = mad(fm.signal, 1, len, 2);
  if ((devR > sqL) || (devJ > sqL)) {
    fm.squelchHits = 0;
    return 1;
  }

  /* weak signal, kill it entirely */
  for (i = 0; i < len; i++) {
    fm.signal2[i / 2] = 0;
  }
  fm.squelchHits++;
  return 0;
}

/* mean average deviation */
function mad(samples, offset, len, step) {
  var i = 0, sum = 0, ave = 0;
  for (i = 0; i < len; i += step) {
    sum += samples[i + offset];
  }
  ave = sum / (len * step);
  sum = 0;
  for (i = 0; i < len; i += step) {
    sum += Math.abs(samples[i + offset] - ave);
  }
  return sum / (len * step);
}

function polarDiscriminant(ar, aj, br, bj) {
  var angle;
  var c = multiply(ar, aj, br, -bj);
  angle = Math.atan2(c.j, c.r);
  return (angle / 3.14159 * (1 << 14));
}

/* define our own complex math ops */
function multiply(ar, aj, br, bj) {
  return {
    r: ar * br - aj * bj,
    j: aj * br + ar * bj
  };
}
