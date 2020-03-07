// parse command line options
var minimist = require('minimist');
var mopts = {
    string: [
        'version',
        'stage',
        'taskId'
    ],
    boolean: [
        'public'
    ]
};

var options = minimist(process.argv, mopts);

// remove well-known parameters from argv before loading make
process.argv = options._;

// modules
var shell = require('shelljs');
var make = require('shelljs/make');
var path = require('path');
var os = require('os');
var cp = require('child_process');
var fs = require('fs');
var semver = require('semver');
var iconv = require('iconv-lite');

// global paths
var sourcePath = path.join(__dirname, 'task');
var binariesPath = path.join(__dirname, '_artifacts', 'binaries');
var packagesPath = path.join(__dirname, '_artifacts', 'packages');

// add node modules .bin to path
var binPath = path.join(__dirname, 'node_modules', '.bin');
var separator = os.platform() === 'win32' ? ';' : ':';
var existing = process.env['PATH'];

if (existing)
    process.env['PATH'] = binPath + separator + existing;
else
    process.env['PATH'] = binPath;

// make targets
target.clean = function() {
    console.log('clean: cleaning binaries');

    shell.rm('-Rf', binariesPath);
    shell.mkdir('-p', binariesPath);
}

target.build = function() {
    target.clean();

    // build task
    console.log('build: building tasks');
    var taskOutputPath = path.join(binariesPath, 'task');
    shell.exec('tsc --outDir ' + taskOutputPath + ' --rootDir ' + sourcePath);
    console.log('  tasks -> ' + taskOutputPath);

    ['ReplaceTokensV3', 'ReplaceTokensV4'].forEach(name => {
        // copy external modules
        getExternalModules(path.join(taskOutputPath, name));
        console.log('  ' + name + '.modules -> ' + path.join(taskOutputPath, name, 'node-modules'))

        shell.cp('-Rf', path.join(__dirname, 'task', name, '*.png'), path.join(taskOutputPath, name));
        shell.cp('-Rf', path.join(__dirname, 'task', name, '*.json'), path.join(taskOutputPath, name));
        console.log('  ' + name + '.resources -> ' + path.join(taskOutputPath, name));
    });

    // copy resources
    ['README.md', 'LICENSE.txt', 'vss-extension.json'].forEach(file => {
        shell.cp('-Rf', path.join(__dirname, file), binariesPath);
        console.log('  ' + file + ' -> ' + path.join(binariesPath, file));
    });

    var imagesPath = path.join(binariesPath, 'images')
    shell.mkdir('-p', imagesPath);

    shell.cp('-Rf', path.join(__dirname, 'images', '*.png'), imagesPath);
    console.log('  images -> ' + imagesPath);
}

getExternalModules = function(dir) {
    var pkg = require('./package.json');
    delete pkg.devDependencies;

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 4));

    var npmPath = shell.which('npm');

    shell.pushd('-q', dir);
    cp.execSync('"' + npmPath + '" install', { stdio: ['pipe', 'ignore', 'pipe'] });
    shell.popd('-q');

    fs.unlinkSync(path.join(dir, 'package.json'));
    fs.unlinkSync(path.join(dir, 'package-lock.json'));
}

target.package = function() {
    console.log('package: packaging task');

    if (options.version) {
        if (options.version === 'auto') {
            var ref = new Date(2000, 1, 1);
            var now = new Date();
            var major = 4
            var minor = Math.floor((now - ref) / 86400000);
            var patch = Math.floor(Math.floor(now.getSeconds() + (60 * (now.getMinutes() + (60 * now.getHours())))) * 0.5)
            options.version = major + '.' + minor + '.' + patch
        }
        
        if (!semver.valid(options.version)) {
            console.error('package', 'Invalid semver version: ' + options.version);
            process.exit(1);
        }
    }
    
    switch (options.stage) {
        case 'dev':
            options.taskId = '0664ff86-f509-4392-a33c-b2d9239b9ae5';
            options.public = false;
            options.instrumentationKey = 'bbfb76b7-7c69-4f45-ac4f-e0e548fd423e';
            break;
    }

    updateExtensionManifest(options);
    updateTaskManifestsAndTelemetry(options);
    
    shell.exec('tfx extension create --root "' + binariesPath + '" --output-path "' + packagesPath +'"')
}

updateExtensionManifest = function(options) {
    var manifestPath = path.join(binariesPath, 'vss-extension.json')
    var manifest = JSON.parse(fs.readFileSync(manifestPath));
    
    if (options.version) {
        manifest.version = options.version;
    }
    
    if (options.stage) {
        manifest.id = manifest.id + '-' + options.stage;
        manifest.name = manifest.name + ' (' + options.stage + ')';
    }

    manifest.public = options.public;
    
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
}

updateTaskManifestsAndTelemetry = function(options) {
    // manifest
    ['ReplaceTokensV3', 'ReplaceTokensV4'].forEach(name => {
        var manifestPath = path.join(binariesPath, 'task', name, 'task.json')
        var manifest = JSON.parse(fs.readFileSync(manifestPath));
        
        if (options.version) {
            manifest.version.Minor = semver.minor(options.version);
            manifest.version.Patch = semver.patch(options.version);
        }

        var version = manifest.version.Major + '.' + manifest.version.Minor + '.' + manifest.version.Patch;
        manifest.helpMarkDown = 'v' + version + ' - ' + manifest.helpMarkDown;

        var taskName = manifest.name;
        if (options.stage) {
            manifest.friendlyName = manifest.friendlyName + ' (' + options.stage;
            taskName += '-' + options.stage;

            if (options.version) {
                manifest.friendlyName = manifest.friendlyName + ' ' + options.version;
            }

            manifest.friendlyName = manifest.friendlyName + ')';
        }
    
        if (options.taskId) {
            manifest.id = options.taskId;
        }
    
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
        
        // telemetry
        var indexPath = path.join(binariesPath, 'task', name, 'index.js');
        var index = iconv.decode(fs.readFileSync(indexPath), 'utf-8');

        if (options.instrumentationKey)
            index = index.replace(/appInsights\.setup\('[^']*'\)/i, "appInsights.setup('" + options.instrumentationKey + "')");

        index = index
            .replace(/telemetry\.context\.tags\[telemetry.context.keys.operationName] = '[^']*'/i, "telemetry.context.tags[telemetry.context.keys.operationName] = '" + taskName + "'")
            .replace(/telemetry\.context\.tags\[telemetry.context.keys.applicationVersion] = '[^']*'/i, "telemetry.context.tags[telemetry.context.keys.applicationVersion] = '" + version + "'")
            .replace(/'taskId': '[^']*'/i, "'taskId': '" + manifest.id + "'");
    
        fs.writeFileSync(indexPath, iconv.encode(index, 'utf-8', { addBOM: false, stripBOM: null, defaultEncoding: null }));
    });
}