"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAppVersion = getAppVersion;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
let cachedVersion = '';
function getAppVersion() {
    if (cachedVersion !== '') {
        return cachedVersion;
    }
    const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const candidatePaths = [
        path_1.default.resolve(currentDir, '../package.json'),
        path_1.default.resolve(currentDir, '../../package.json'),
        path_1.default.resolve(currentDir, 'package.json'),
        path_1.default.resolve(process.cwd(), 'package.json'),
    ];
    for (const pkgPath of candidatePaths) {
        if ((0, fs_1.existsSync)(pkgPath)) {
            try {
                const pkg = JSON.parse((0, fs_1.readFileSync)(pkgPath, 'utf-8'));
                if (pkg.name === 'lumio' && typeof pkg.version === 'string') {
                    cachedVersion = pkg.version;
                    return cachedVersion;
                }
            }
            catch { }
        }
    }
    cachedVersion = '2.0.2';
    return cachedVersion;
}
