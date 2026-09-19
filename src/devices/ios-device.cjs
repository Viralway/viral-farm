'use strict';

const path = require('node:path');
const Module = require('module');
const originalLoad = Module._load;

Module._load = function loadBplistCompat(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    const id = typeof request === 'string' ? request : '';
    if (
        (id === 'bplist-parser' || id.includes(`${path.sep}bplist-parser${path.sep}`) || id.endsWith('bplist-parser'))
        && exported
        && typeof exported === 'object'
        && typeof exported.UID === 'function'
        && typeof exported.parseBuffer === 'function'
        && !exported.default
    ) {
        exported.default = exported;
    }
    return exported;
};

module.exports = require('appium-ios-device');
