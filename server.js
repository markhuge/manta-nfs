// Copyright 2014 Joyent, Inc.  All rights reserved.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

var fs = require('fs');
var os = require('os');
var path = require('path');
var util = require('util');

var userid = require('userid');
var assert = require('assert-plus');
var bunyan = require('bunyan');
var clone = require('clone');
var dashdash = require('dashdash');
var LRU = require('lru-cache');
var nfs = require('nfs');
var rpc = require('oncrpc');
var mantafs = require('mantafs');
var vasync = require('vasync');

var app = require('./lib');

// uid/gid for 'nobody' on non-windows systems
var uid = 0;
var gid = 0;
var os_platform;

///--- Globals

var LOG = app.bunyan.createLogger();

var OPTIONS_PARSER = dashdash.createParser({
    options: [
        {
            names: ['file', 'f'],
            type: 'string',
            help: 'configuration file to use',
            helpArg: 'FILE'
        },
        {
            names: ['debug', 'd'],
            type: 'bool',
            help: 'turn on debug bunyan logging'
        },
        {
            names: ['verbose', 'v'],
            type: 'bool',
            help: 'turn on verbose bunyan logging'
        }
    ]
});



///--- Functions

function usage(msg) {
    var help = OPTIONS_PARSER.help({
        includeEnv: true
    }).trimRight();

    if (msg)
        console.error(util.format.apply(util, arguments));
    console.error('usage: nfsd [OPTIONS]\noptions:\n' + help);

    process.exit(msg ? 1 : 0);
}


function configure() {
    var opts;

    try {
        opts = OPTIONS_PARSER.parse(process.argv);
    } catch (e) {
        usage(e.message);
    }

    if (opts.verbose) {
        LOG = LOG.child({
            level: 'trace',
            src: true
        });
    } else if (opts.debug) {
        LOG = LOG.child({
            level: 'debug',
            src: true
        });
    } else {
        LOG = LOG.child({
            level: 'info',
            src: true
        });
    }

    if (opts.help)
        usage();

    var cfg;
    if (opts.file) {
        try {
            cfg = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
        } catch (e) {
            usage('unable to load %s:\n%s\n', opts.file, e.toString());
        }
    } else {
        cfg = {};
    }

    // If no config, let createMantaClient handle setup using env
    if (!cfg.manta)
        cfg.manta = {};

    if (cfg.database) {
        assert.object(cfg.database, 'config.database');
    } else {
        cfg.database = {};
    }

    // default local cache config values if any are not provided
    if (!cfg.database.location)
        cfg.database.location = '/var/tmp/mfsdb';

    if (!cfg.database.sizeMB)
        cfg.database.sizeMB = 5120;

    if (!cfg.database.ttl)
        cfg.database.ttl = 43200;

    if (!cfg.database.wbtime)
        cfg.database.wbtime = 60;

    if (!cfg.database.num_par)
        cfg.database.num_par = 2;

    if (cfg.portmap) {
        assert.object(cfg.portmap, 'config.portmap');
        // Normally only define this section if setting
        //     'usehost': 1
    } else {
        // our built-in portmapper just hardcodes the standard info
        cfg.portmap = {
            'port': 111,
            'mappings': {
                'mountd': [ {
                    'prog': 100005,
                    'vers': 3,
                    'prot': 6,
                    'port': 1892
                }, {
                    'prog': 100005,
                    'vers': 1,
                    'prot': 6,
                    'port': 1892
                }],
                'nfsd': [ {
                    'prog': 100003,
                    'vers': 3,
                    'prot': 6,
                    'port': 2049
                }],
                'portmapd': [ {
                    'prog': 100000,
                    'vers': 2,
                    'prot': 6,
                    'port': 111
                }]
            }
        };
    }

    // Can set 'address' to enable the mountd server to listen on an IP address
    // other than the loopback.
    // Can define hosts_allow and hosts_deny to list the addresses of hosts
    // which can/cannot mount. e.g.
    //     'hosts_allow': {
    //        '192.168.0.10': {},
    //        '192.168.0.11': {}
    //     },
    //     'hosts_deny': {
    //        '192.168.0.12': {},
    //        '192.168.0.13': {}
    //     }
    // Can set exports if you want to limit what parts of the manta namespace
    // can be mounted:
    //     'exports': {
    //        '/user/stor/project': {},
    //        '/user/public': {}
    //     }
    cfg.mount = cfg.mount || {};
    assert.object(cfg.mount, 'config.mount');

    // Can set uid and gid to specify the uid/gid for 'nobody' on the client.
    // If not provided, the server's values for 'nobody' will be used.
    if (!cfg.nfs) {
        var t_uid;
        var t_gid;

        try {
            t_uid = convert_neg_id(userid.uid('nobody'));
        } catch (e1) {
            t_uid = 65534;
        }

        try {
            t_gid = convert_neg_id(userid.gid('nobody'));
        } catch (e1) {
            // Linux uses 'nogroup' instead of 'nobody'
            try {
                t_gid = convert_neg_id(userid.gid('nogroup'));
            } catch (e2) {
                t_gid = t_uid;
            }
        }

        cfg.nfs = {
            'uid': t_uid,
            'gid': t_gid
        };
    }

    assert.object(cfg.nfs, 'config.nfs');
    cfg.nfs.fd_cache = cfg.nfs.fd_cache || {
        max: 10000,
        ttl: 60
    };
    cfg.nfs.hosts_allow = cfg.mount.hosts_allow;
    cfg.nfs.hosts_deny = cfg.mount.hosts_deny;

    cfg.log = LOG;
    cfg.manta.log = LOG;
    cfg.mount.log = LOG;
    cfg.nfs.log = LOG;
    cfg.portmap.log = LOG;

    cfg.manta = app.createMantaClient(cfg.manta);
    cfg.mount.manta = cfg.manta;
    cfg.nfs.manta = cfg.manta;

    return (cfg);
}


function step_down() {
    try {
        process.setgid(gid);
        process.setuid(uid);
        LOG.info('server now running as \'nobody\'');
    } catch (e) {
        LOG.fatal(e, 'unable to setuid/setgid to nobody');
        process.exit(1);
    }
}

// Runs the mountd and nfsd servers. Called once we're registered with the
// system's portmapper or once we've started our own portmapper.
function run_servers(log, cfg_mount, cfg_nfs) {
    var barrier = vasync.barrier();
    var mountd = app.createMountServer(cfg_mount);
    var nfsd = app.createNfsServer(cfg_nfs);

    barrier.on('drain', function onRunning() {
        var ma = mountd.address();
        var na = nfsd.address();

        log.info('mountd: listening on: tcp://%s:%d',
                 ma.address, ma.port);
        log.info('nfsd: listening on: tcp://%s:%d',
                 na.address, na.port);

        if (uid !== 0) {
            // On non-windows machines we run as 'nobody'.
            // On sunos we have to wait until after we're listening on the nfs
            // port since the user 'nobody' will not have the sys_nfs priv.
            // On darwin 'nobody' is -2 and we error setting the uid/gid to a
            // negative number, so use the symbolic name.
            if (os_platform === 'darwin') {
                gid = uid = 'nobody';
            }
            step_down();
        }
    });

    mountd.on('error', function (e) {
        if (e.code == 'EADDRINUSE') {
            log.fatal('mountd already running, exiting.');
        } else {
            log.fatal(e, 'unable to run the mountd');
        }
        process.exit(1);
    });

    nfsd.on('error', function (e) {
        if (e.code == 'EADDRINUSE') {
            log.fatal('nfsd already running, exiting.');
        } else {
            log.fatal(e, 'unable to run the nfsd');
        }
        process.exit(1);
    });

    barrier.start('mount');
    mountd.listen(cfg_mount.port || 1892,
                  cfg_mount.address || '127.0.0.1',
                  barrier.done.bind(barrier, 'mount'));

    // nfsd needs to listen on the same IP as configured for the mountd
    barrier.start('nfs');
    nfsd.listen(cfg_nfs.port || 2049,
                cfg_mount.address || '127.0.0.1',
                barrier.done.bind(barrier, 'nfs'));
}

// Darwin uses negative numbers for 'nobody' but these get pulled out as a
// large non-negative number. Convert to twos-complement.
function convert_neg_id(id)
{
    if (id > 0x7fffffff)
        return (-(~id + 1));
    else
        return (id);
}

///--- Mainline

(function main() {
    var cfg = configure();
    var log = cfg.log;

    os_platform = os.platform();
    if (os_platform !== 'win32' && os_platform !== 'darwin') {
        uid = convert_neg_id(userid.uid('nobody'));
        try {
            gid = convert_neg_id(userid.gid('nobody'));
        } catch (e1) {
            // Linux uses 'nogroup' instead of 'nobody'
            try {
                gid = convert_neg_id(userid.gid('nogroup'));
            } catch (e2) {
                gid = uid;
            }
        }
    }

    var mfs = mantafs.createClient({
        log: log.child({component: 'MantaFs'}, true),
        manta: cfg.manta,
        path: cfg.database.location,
        sizeMB: cfg.database.sizeMB,
        ttl: cfg.database.ttl,
        wbtime: cfg.database.wbtime,
        num_par: cfg.database.num_par,
        uid: cfg.nfs.uid || uid,
        gid: cfg.nfs.gid || gid
    });

    // must always use the system's portmapper on sunos
    if (os_platform === 'sunos')
        cfg.portmap.usehost = true;

    cfg.mount.fs = mfs;
    cfg.nfs.fs = mfs;
    cfg.nfs.fd_cache = LRU({
        dispose: function cache_close_fd(k, v) {
            mfs.close(v.fd, function on_close(err) {
                if (err)
                    log.debug(err, 'failed to close(fd=%d) for %s', v.fd, k);
            });
        },
        max: cfg.nfs.fd_cache.max,
        maxAge: cfg.nfs.fd_cache.ttl * 1000 // 1m TTL
    });

    cfg.nfs.cachepath = cfg.database.location;    // used by fsstat

    log.info('configuration: %s', util.inspect(cfg));

    var mntmapping = {
        prog: 100005,
        vers: 3,
        prot: 6,
        port: 1892
    };

    var nfsmapping = {
        prog: 100003,
        vers: 3,
        prot: 6,
        port: 2049
    };

    function cleanup() {
        mfs.shutdown(function (err) {
            if (err) {
                log.warn(err, 'mantafs shutdown error');
            }

            if (cfg.portmap.usehost) {
                var pmapclient = app.createPortmapClient(cfg.portmap);

                pmapclient.once('connect', function () {
                    pmapclient.unset(mntmapping, function (err1) {
                        if (err1) {
                            log.warn(err1,
                                'unregistering mountd from the portmapper');
                        }

                        pmapclient.unset(nfsmapping, function (err2) {
                            if (err2) {
                                log.warn(err2,
                                    'unregistering nfsd from the portmapper');
                            }
                            log.info('Shutdown complete, exiting.');
                            process.exit(0);
                        });
                    });
                });
            } else {
                log.info('Shutdown complete, exiting.');
                process.exit(0);
            }
        });
    }

    process.on('SIGTERM', function () {
        log.info('Got SIGTERM, shutting down.');
        cleanup();
    });

    process.on('SIGINT', function () {
        log.info('Got SIGINT, shutting down.');
        cleanup();
    });

    mfs.once('error', function (err) {
        log.fatal(err, 'unable to initialize mantafs cache');
        process.exit(1);
    });
    mfs.once('ready', function () {
        // Cache exists now, ensure cache dir modes are more secure
        fs.chmodSync(mfs.cache.location, 0700);
        fs.chmodSync(path.join(mfs.cache.location, 'fscache'), 0700);
        fs.chmodSync(path.join(mfs.cache.location, 'mantafs.db'), 0600);
        if (uid !== 0) {
            // On non-windows machines we run as 'nobody'. Tighten up now.
            fs.chownSync(mfs.cache.location, uid, gid);
            fs.chownSync(path.join(mfs.cache.location, 'fscache'), uid, gid);
            fs.chownSync(path.join(mfs.cache.location, 'mantafs.db'), uid, gid);
        }

        // the portmapper needs to listen on all addresses, unlike our mountd
        // and nfsd which only listen on localhost by default for some basic
        // security
        cfg.portmap.address = cfg.portmap.address || '0.0.0.0';
        cfg.portmap.port = cfg.portmap.port || 111;

        // Use the system's portmapper
        function register_with_pmap() {
            // The Linux portmapper normally rejects requests that are not
            // made to the loopback address.
            cfg.portmap.url = util.format('udp://127.0.0.1:%d',
                cfg.portmap.port);
            var pmapclient = app.createPortmapClient(cfg.portmap);

            pmapclient.on('error', function (e) {
                log.fatal(e, 'unable to connect to the system`s portmapper');
                process.exit(1);
            });

            pmapclient.once('connect', function () {
                pmapclient.set(mntmapping, function (err1) {
                    if (err1) {
                        log.fatal(err1,
                            'unable to register mountd with the portmapper');
                        process.exit(1);
                    }

                    pmapclient.set(nfsmapping, function (err2) {
                        if (err2) {
                            log.fatal(err2,
                                'unable to register nfsd with the portmapper');
                            process.exit(1);
                        }

                        pmapclient.close();
                        run_servers(cfg.log, cfg.mount, cfg.nfs);
                    });
                });
            });
        }

        if (cfg.portmap.usehost) {
            register_with_pmap();
        } else {
            // Here we run our own portmapper
            var pmapd = app.createPortmapServer(cfg.portmap);

            pmapd.on('error', function (e) {
                if (e.code == 'EADDRINUSE') {
                    log.info('Portmapper running, registering there...');
                    cfg.portmap.usehost = 1;
                    register_with_pmap();
                } else {
                    log.fatal(e, 'unable to run the portmapper');
                    process.exit(1);
                }
            });

            pmapd.listen(cfg.portmap.port, cfg.portmap.address, function () {
                run_servers(cfg.log, cfg.mount, cfg.nfs);
            });
       }
    });
})();
