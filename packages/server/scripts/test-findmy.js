const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const typescript = require("typescript");

const loadTypeScriptModule = (relativeSourcePath, moduleMocks = {}) => {
    const sourcePath = path.resolve(__dirname, relativeSourcePath);
    const sourceCode = fs.readFileSync(sourcePath, "utf8");
    const compiledCode = typescript.transpileModule(sourceCode, {
        compilerOptions: {
            module: typescript.ModuleKind.CommonJS,
            target: typescript.ScriptTarget.ES2020
        },
        fileName: sourcePath
    }).outputText;

    const loadedModule = { exports: {} };
    const executeModule = new Function("require", "module", "exports", compiledCode);
    const moduleRequire = moduleName => {
        if (Object.prototype.hasOwnProperty.call(moduleMocks, moduleName)) return moduleMocks[moduleName];
        if (moduleName.startsWith(".")) {
            const resolvedTs = path.resolve(path.dirname(sourcePath), `${moduleName}.ts`);
            if (fs.existsSync(resolvedTs)) return loadTypeScriptModule(path.relative(__dirname, resolvedTs), moduleMocks);
        }
        return require(moduleName);
    };
    executeModule(moduleRequire, loadedModule, loadedModule.exports);
    return loadedModule.exports;
};

const findMyUtilities = loadTypeScriptModule("../src/server/api/lib/findmy/utils.ts");
const { normalizeFindMyDevice, normalizeFindMyDevices, normalizeFindMyFriendLocation, normalizeFindMyFriendLocations } =
    findMyUtilities;
const { JsonLineBuffer } = loadTypeScriptModule("../src/server/api/privateApi/JsonLineBuffer.ts");
const { selectPrivateApiClients } = loadTypeScriptModule("../src/server/api/privateApi/PrivateApiClientSelector.ts");
const findMyPrivateApiSupport = loadTypeScriptModule("../src/server/api/lib/findmy/privateApiSupport.ts");
const {
    FIND_MY_PROCESS_IDENTIFIER,
    MESSAGES_PROCESS_IDENTIFIER,
    resolveFindMyDevicesPrivateApiTarget,
    resolveFindMyFriendsPrivateApiTarget
} = findMyPrivateApiSupport;

const normalizedLocation = normalizeFindMyFriendLocation({
    handle: " alice@example.com ",
    coordinates: ["47.61", "-122.33"],
    long_address: " Seattle, WA ",
    short_address: null,
    subtitle: "",
    title: [42, "", " Alice "],
    last_updated: "1234567",
    is_locating_in_progress: true,
    status: "live",
    location_type: "2",
    horizontal_accuracy: "6.5",
    vertical_accuracy: 9,
    speed: "1.25",
    altitude: 32,
    description: "must not cross the API boundary"
});

assert.equal(normalizedLocation.handle, "alice@example.com");
assert.deepEqual(normalizedLocation.coordinates, [47.61, -122.33]);
assert.equal(normalizedLocation.long_address, "Seattle, WA");
assert.equal(normalizedLocation.short_address, null);
assert.equal(normalizedLocation.subtitle, null);
assert.equal(normalizedLocation.title, "Alice");
assert.equal(normalizedLocation.last_updated, 1234567);
assert.equal(normalizedLocation.is_live, true);
assert.equal(normalizedLocation.locating_in_progress, true);
assert.equal(normalizedLocation.is_locating_in_progress, true);
assert.equal(normalizedLocation.status, "live");
assert.equal(normalizedLocation.location_type, 2);
assert.equal(normalizedLocation.horizontal_accuracy, 6.5);
assert.equal(normalizedLocation.vertical_accuracy, 9);
assert.equal(normalizedLocation.speed, 1.25);
assert.equal(normalizedLocation.altitude, 32);
assert.equal(normalizedLocation.city, "Seattle");
assert.equal(normalizedLocation.state, "WA");
assert.equal(Object.prototype.hasOwnProperty.call(normalizedLocation, "description"), false);

const granularFriendLocation = normalizeFindMyFriendLocation({
    handle: "carol@example.com",
    coordinates: [37.7824, -122.2165],
    long_address: "3501 Fruitvale Ave, Oakland, CA 94602, United States",
    short_address: "Oakland, CA",
    last_updated: 1700000000000,
    status: "shallow",
    location_type: 1,
    is_locating_in_progress: false
});
assert.equal(granularFriendLocation.long_address, "3501 Fruitvale Ave, Oakland, CA 94602, United States");
assert.equal(granularFriendLocation.street, "3501 Fruitvale Ave");
assert.equal(granularFriendLocation.city, "Oakland");
assert.equal(granularFriendLocation.state, "CA");
assert.equal(granularFriendLocation.zip, "94602");
assert.equal(granularFriendLocation.country, "United States");
assert.equal(granularFriendLocation.is_live, false, "shallow must never set is_live=true");
assert.equal(granularFriendLocation.locating_in_progress, false);

const zeroTimestampLocation = normalizeFindMyFriendLocation({
    handle: "zero@example.com",
    coordinates: [37.78, -122.22],
    last_updated: 0,
    status: "legacy"
});
assert.equal(zeroTimestampLocation.last_updated, null, "timestamp 0 must normalize to null, never Date.now()");

const missingLocation = normalizeFindMyFriendLocation({
    handle: "bob@example.com",
    coordinates: [null, ""],
    long_address: null,
    short_address: null,
    subtitle: null,
    title: null,
    last_updated: "",
    is_locating_in_progress: 0,
    status: "unexpected"
});

assert.equal(missingLocation.coordinates, null, "null or blank coordinates must not become (0, 0)");
assert.equal(missingLocation.last_updated, null);
assert.equal(missingLocation.status, null);
assert.equal(missingLocation.is_live, false);
assert.equal(missingLocation.locating_in_progress, false);

const invalidCoordinateLocation = normalizeFindMyFriendLocation({
    ...missingLocation,
    coordinates: [91, -122.33]
});
assert.equal(invalidCoordinateLocation.coordinates, null);

const identifiedLocations = normalizeFindMyFriendLocations([
    normalizedLocation,
    { ...missingLocation, handle: null },
    missingLocation
]);
assert.deepEqual(
    identifiedLocations.map(location => location.handle),
    ["alice@example.com", "bob@example.com"]
);
assert.deepEqual(normalizeFindMyFriendLocations(null), []);

const rawDeviceWithLocation = {
    identifier: " device-1 ",
    name: " Example Mac ",
    displayName: " MacBook Pro ",
    model: "Mac14,6",
    rawDeviceModel: "Mac14,6-silver",
    systemVersion: "15.7.7",
    batteryLevel: "0.75",
    batteryStatus: "charging",
    deviceConnectedState: "online",
    discoveryIdentifier: "00000000-0000-4000-8000-000000000001",
    category: "MacBookPro",
    address: {
        label: " Seattle, WA ",
        countryCode: "US",
        administrativeArea: "WA",
        locality: "Seattle",
        streetAddress: "400 Broad St",
        postalCode: "98109",
        mapItemFullAddress: "400 Broad St, Seattle, WA 98109",
        formattedAddressLines: ["400 Broad St", "Seattle, WA 98109"]
    },
    location: {
        latitude: "47.61",
        longitude: "-122.33",
        horizontalAccuracy: "6.5",
        verticalAccuracy: 9,
        altitude: 32,
        timeStamp: "1234567",
        floorLevel: 4,
        isInaccurate: false,
        isOld: false,
        locationFinished: true,
        positionType: "current"
    },
    description: "must not cross the API boundary"
};
const normalizedDeviceWithLocation = normalizeFindMyDevice(rawDeviceWithLocation);
assert.equal(normalizedDeviceWithLocation.identifier, "device-1");
assert.equal(normalizedDeviceWithLocation.name, "Example Mac");
assert.equal(normalizedDeviceWithLocation.systemVersion, "15.7.7");
assert.equal(normalizedDeviceWithLocation.batteryLevel, 0.75);
assert.equal(normalizedDeviceWithLocation.batteryStatus, "charging");
assert.equal(normalizedDeviceWithLocation.deviceStatus, "online");
assert.equal(normalizedDeviceWithLocation.location.latitude, 47.61);
assert.equal(normalizedDeviceWithLocation.location.longitude, -122.33);
assert.equal(normalizedDeviceWithLocation.location.timeStamp, 1234567);
assert.equal(normalizedDeviceWithLocation.last_updated, 1234567);
assert.equal(normalizedDeviceWithLocation.is_live, false);
assert.equal(normalizedDeviceWithLocation.long_address, "400 Broad St, Seattle, WA 98109");
assert.equal(normalizedDeviceWithLocation.street, "400 Broad St");
assert.equal(normalizedDeviceWithLocation.city, "Seattle");
assert.equal(normalizedDeviceWithLocation.state, "WA");
assert.equal(normalizedDeviceWithLocation.zip, "98109");
assert.deepEqual(normalizedDeviceWithLocation.address.formattedAddressLines, ["400 Broad St", "Seattle, WA 98109"]);
assert.equal(
    normalizedDeviceWithLocation.crowdSourcedLocation,
    undefined,
    "a direct location must not be relabeled as crowd-sourced"
);
assert.equal(Object.prototype.hasOwnProperty.call(normalizedDeviceWithLocation, "description"), false);

const normalizedOfflineDevice = normalizeFindMyDevice({
    identifier: "offline-device",
    batteryLevel: 0,
    location: null
});
assert.equal(normalizedOfflineDevice.batteryLevel, 0);
assert.equal(normalizedOfflineDevice.location, undefined, "an offline device must not gain zero coordinates");
assert.equal(
    normalizeFindMyDevice({ identifier: "", discoveryIdentifier: "fallback" }),
    null,
    "the server contract requires the helper's selected stable identifier"
);
assert.equal(
    normalizeFindMyDevice({ identifier: "invalid", location: { latitude: 91, longitude: 1 } }).location,
    undefined
);
assert.equal(normalizeFindMyDevice({ identifier: "invalid", batteryLevel: true }).batteryLevel, undefined);
assert.equal(
    normalizeFindMyDevice({ identifier: "invalid", location: { latitude: [], longitude: false } }).location,
    undefined
);
assert.deepEqual(normalizeFindMyDevices(null), []);

const { FindMyFriendsCache } = loadTypeScriptModule("../src/server/api/lib/findmy/FindMyFriendsCache.ts", {
    "@server/helpers/utils": {
        isEmpty: value => value == null || (typeof value === "string" && value.trim().length === 0)
    }
});
const friendLocationCache = new FindMyFriendsCache();
friendLocationCache.updateAll([normalizedLocation, missingLocation]);
assert.equal(friendLocationCache.getAll().length, 2);
friendLocationCache.replaceAll([{ ...normalizedLocation, last_updated: 1 }]);
assert.deepEqual(friendLocationCache.getAll(), [normalizedLocation]);
// Strictly newer shallow/legacy updates must supersede cached live entries.
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "shallow",
        last_updated: normalizedLocation.last_updated + 500
    }),
    true
);
assert.equal(friendLocationCache.get("alice@example.com").status, "shallow");
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "live",
        last_updated: normalizedLocation.last_updated + 1000
    }),
    true
);
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "legacy",
        coordinates: null,
        last_updated: normalizedLocation.last_updated + 2000
    }),
    true
);
assert.equal(friendLocationCache.get("alice@example.com").status, "legacy");
// Same-timestamp downgrades (legacy/shallow over live) must still be dropped.
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "live",
        last_updated: normalizedLocation.last_updated + 3000
    }),
    true
);
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "legacy",
        last_updated: normalizedLocation.last_updated + 3000
    }),
    false
);
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "shallow",
        last_updated: normalizedLocation.last_updated + 3000
    }),
    false
);
assert.equal(
    friendLocationCache.update({
        ...normalizedLocation,
        status: "live",
        is_locating_in_progress: false,
        last_updated: normalizedLocation.last_updated + 3000
    }),
    true
);
friendLocationCache.replaceAll([]);
assert.deepEqual(friendLocationCache.getAll(), []);

const { FindMyDevicesCache } = loadTypeScriptModule("../src/server/api/lib/findmy/FindMyDevicesCache.ts");
const deviceCache = new FindMyDevicesCache();
deviceCache.updateAll([normalizedDeviceWithLocation]);
assert.deepEqual(deviceCache.getAll(), [normalizedDeviceWithLocation]);
deviceCache.updateAll([normalizedOfflineDevice]);
assert.equal(deviceCache.getAll().length, 2);
deviceCache.replaceAll([normalizedOfflineDevice]);
assert.deepEqual(deviceCache.getAll(), [normalizedOfflineDevice]);
deviceCache.replaceAll([]);
assert.deepEqual(deviceCache.getAll(), []);

const fragmentedMessages = new JsonLineBuffer();
assert.deepEqual(fragmentedMessages.append('{"transactionId":"abc","locations":['), []);
assert.deepEqual(fragmentedMessages.append("]}\n"), ['{"transactionId":"abc","locations":[]}']);

const coalescedMessages = new JsonLineBuffer();
assert.deepEqual(coalescedMessages.append('{"event":"ping"}\n{"event":"ping"}\n'), [
    '{"event":"ping"}',
    '{"event":"ping"}'
]);

const splitDelimiterMessages = new JsonLineBuffer();
assert.deepEqual(splitDelimiterMessages.append('{"event":"first"}\n{"event":"second"}'), ['{"event":"first"}']);
assert.deepEqual(splitDelimiterMessages.append("\n"), ['{"event":"second"}']);

const utf8Message = '{"title":"Café"}\n';
const utf8MessageBytes = Buffer.from(utf8Message);
const accentedCharacterOffset = utf8MessageBytes.indexOf(Buffer.from("é"));
const splitUtf8Messages = new JsonLineBuffer();
assert.deepEqual(splitUtf8Messages.append(utf8MessageBytes.subarray(0, accentedCharacterOffset + 1)), []);
assert.deepEqual(splitUtf8Messages.append(utf8MessageBytes.subarray(accentedCharacterOffset + 1)), [
    utf8Message.trim()
]);

const messagesClient = { name: "messages", destroyed: false };
const findMyClient = { name: "findmy", destroyed: false };
const disconnectedClient = { name: "disconnected", destroyed: true };
const connectedClients = [messagesClient, findMyClient, disconnectedClient];
const clientsByProcessIdentifier = {
    "com.apple.MobileSMS": messagesClient,
    "com.apple.findmy": findMyClient,
    "com.apple.disconnected": disconnectedClient
};

assert.deepEqual(selectPrivateApiClients(connectedClients, clientsByProcessIdentifier, "com.apple.findmy"), [
    findMyClient
]);
assert.deepEqual(selectPrivateApiClients(connectedClients, clientsByProcessIdentifier, "com.apple.unknown"), []);
assert.deepEqual(selectPrivateApiClients(connectedClients, clientsByProcessIdentifier, "com.apple.disconnected"), []);
assert.deepEqual(selectPrivateApiClients(connectedClients, clientsByProcessIdentifier), [messagesClient, findMyClient]);

assert.equal(
    resolveFindMyFriendsPrivateApiTarget({ isMinBigSur: false, isMinSonoma: false, isMinSequoia: false }),
    null
);
assert.equal(
    resolveFindMyFriendsPrivateApiTarget({ isMinBigSur: true, isMinSonoma: false, isMinSequoia: false }),
    MESSAGES_PROCESS_IDENTIFIER
);
assert.equal(resolveFindMyFriendsPrivateApiTarget({ isMinBigSur: true, isMinSonoma: true, isMinSequoia: false }), null);
assert.equal(
    resolveFindMyFriendsPrivateApiTarget({ isMinBigSur: true, isMinSonoma: true, isMinSequoia: true }),
    FIND_MY_PROCESS_IDENTIFIER
);
assert.equal(resolveFindMyDevicesPrivateApiTarget({ isMinSequoia: false }), null);
assert.equal(resolveFindMyDevicesPrivateApiTarget({ isMinSequoia: true }), FIND_MY_PROCESS_IDENTIFIER);

let activeServer;
let openedFindMyCommands = [];
const loadFindMyInterface = environment => {
    return loadTypeScriptModule("../src/server/api/interfaces/findMyInterface.ts", {
        "@server": { Server: () => activeServer },
        "@server/fileSystem": {
            FileSystem: {
                execShellCommand: async command => openedFindMyCommands.push(command)
            }
        },
        "@server/events": { NEW_FINDMY_DEVICE: "new-findmy-device" },
        "@server/env": environment,
        "@server/helpers/utils": { waitMs: async () => {} },
        "../apple/scripts": {
            quitFindMyFriends: () => "",
            startFindMyFriends: () => "",
            showFindMyFriends: () => "",
            hideFindMyFriends: () => ""
        },
        "@server/api/lib/findmy/utils": findMyUtilities,
        "@server/api/lib/findmy/privateApiSupport": findMyPrivateApiSupport
    }).FindMyInterface;
};

let FindMyInterface = loadFindMyInterface({ isMinBigSur: true, isMinSonoma: true, isMinSequoia: true });

const createRefreshScenario = ({
    helperAvailable,
    helperResponse,
    helperError,
    fallbackError,
    expectedPrivateApiTarget = FIND_MY_PROCESS_IDENTIFIER,
    initialLocations = [normalizedLocation]
}) => {
    let cachedLocations = [...initialLocations];
    const observations = {
        fallbackCalls: 0,
        helperCalls: 0,
        privateApiTargets: [],
        warnings: []
    };

    activeServer = {
        repo: {
            getConfig: name => name === "enable_private_api"
        },
        privateApi: {
            hasClient: processIdentifier => {
                observations.privateApiTargets.push(processIdentifier);
                assert.equal(processIdentifier, expectedPrivateApiTarget);
                return helperAvailable;
            },
            findmy: {
                refreshFriends: async () => {
                    observations.helperCalls += 1;
                    if (helperError) throw helperError;
                    return helperResponse;
                }
            }
        },
        findMyFriendsCache: {
            getAll: () => cachedLocations,
            updateAll: locations => {
                if (locations.length > 0) cachedLocations = locations;
                return locations;
            },
            replaceAll: locations => {
                cachedLocations = [...locations];
                return locations;
            }
        },
        logger: {
            debug: () => {},
            warn: message => observations.warnings.push(message)
        }
    };

    FindMyInterface.refreshUsingFindMyApp = async () => {
        observations.fallbackCalls += 1;
        if (fallbackError) throw fallbackError;
    };

    return observations;
};

const settleBackgroundFallback = () => new Promise(resolve => setImmediate(resolve));

const createDeviceRefreshScenario = ({
    helperAvailable = true,
    helperResponse,
    initialDevices = [],
    privateApiEnabled = true,
    openFindMyOnStartup = true
}) => {
    let cachedDevices = [...initialDevices];
    openedFindMyCommands = [];
    const observations = {
        helperCalls: 0,
        privateApiTargets: [],
        replacements: 0,
        updates: 0,
        warnings: []
    };

    activeServer = {
        repo: {
            getConfig: name => {
                if (name === "enable_private_api") return privateApiEnabled;
                if (name === "open_findmy_on_startup") return openFindMyOnStartup;
                return null;
            }
        },
        privateApi: {
            hasClient: processIdentifier => {
                observations.privateApiTargets.push(processIdentifier);
                assert.equal(processIdentifier, FIND_MY_PROCESS_IDENTIFIER);
                return helperAvailable;
            },
            findmy: {
                refreshDevices: async () => {
                    observations.helperCalls += 1;
                    return helperResponse;
                }
            }
        },
        findMyDevicesCache: {
            getAll: () => [...cachedDevices],
            updateAll: devices => {
                observations.updates += 1;
                const devicesByIdentifier = new Map(
                    cachedDevices.map(device => [device.identifier ?? device.id, device])
                );
                for (const device of devices) {
                    devicesByIdentifier.set(device.identifier ?? device.id, device);
                }
                cachedDevices = Array.from(devicesByIdentifier.values());
                return devices;
            },
            replaceAll: devices => {
                observations.replacements += 1;
                cachedDevices = [...devices];
                return devices;
            }
        },
        logger: {
            debug: () => {},
            warn: message => observations.warnings.push(message)
        }
    };

    return observations;
};

const runFindMyDylibPluginTests = async () => {
    const scenarios = [
        { cachedFriends: 0, cachedDevices: 0, expectedRefreshes: ["friends", "devices"] },
        { cachedFriends: 1, cachedDevices: 0, expectedRefreshes: ["devices"] },
        { cachedFriends: 0, cachedDevices: 1, expectedRefreshes: ["friends"] },
        { cachedFriends: 1, cachedDevices: 1, expectedRefreshes: [] }
    ];

    for (const scenario of scenarios) {
        const refreshes = [];
        activeServer = {
            findMyFriendsCache: {
                getAll: () => Array.from({ length: scenario.cachedFriends }, () => ({}))
            },
            findMyDevicesCache: {
                getAll: () => Array.from({ length: scenario.cachedDevices }, () => ({}))
            }
        };

        const { FindMyDylibPlugin } = loadTypeScriptModule(
            "../src/server/api/privateApi/modes/dylibPlugins/FindMyDylibPlugin.ts",
            {
                "@server/env": { isMinSequoia: true },
                ".": {
                    DylibPlugin: class {
                        constructor(name) {
                            this.name = name;
                        }
                    }
                },
                "@server/fileSystem": { FileSystem: { resources: "/resources" } },
                "@server": { Server: () => activeServer },
                "@server/api/interfaces/findMyInterface": {
                    FindMyInterface: {
                        refreshFriends: async () => refreshes.push("friends"),
                        refreshDevices: async () => refreshes.push("devices")
                    }
                }
            }
        );

        const plugin = new FindMyDylibPlugin("Find My Helper");
        await plugin.afterClientRegistration();
        assert.deepEqual(refreshes, scenario.expectedRefreshes);
    }
};

const runRefreshBranchTests = async () => {
    let observations = createRefreshScenario({ helperAvailable: false });
    let locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.equal(observations.helperCalls, 0);
    assert.equal(observations.fallbackCalls, 1);
    assert.equal(locations.length, 1);

    observations = createRefreshScenario({
        helperAvailable: true,
        helperResponse: {
            data: {
                locations: [],
                partial: true,
                friendListTimedOut: true,
                timedOutHandles: [],
                skippedFriends: 0
            }
        }
    });
    locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.equal(observations.helperCalls, 1);
    assert.equal(observations.fallbackCalls, 1, "an empty partial helper response must start the fallback");
    assert.equal(locations.length, 1, "an empty partial response must not erase cached friends");

    observations = createRefreshScenario({
        helperAvailable: true,
        helperResponse: {
            data: {
                locations: [{ handle: null }],
                partial: false,
                friendListTimedOut: false,
                timedOutHandles: [],
                skippedFriends: 0
            }
        }
    });
    locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.equal(observations.fallbackCalls, 1, "an invalid snapshot must start the fallback");
    assert.equal(locations.length, 1, "an invalid snapshot must not erase cached friends");
    assert.equal(observations.warnings.length, 1, "an invalid snapshot must be visible in diagnostics");

    observations = createRefreshScenario({
        helperAvailable: true,
        helperResponse: {
            data: {
                locations: [normalizedLocation],
                partial: true,
                friendListTimedOut: false,
                timedOutHandles: ["bob@example.com"],
                skippedFriends: 0
            }
        }
    });
    locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.equal(observations.fallbackCalls, 0, "a partial response with usable records must not restart Find My");
    assert.equal(locations.length, 1);

    observations = createRefreshScenario({
        helperAvailable: true,
        helperResponse: {
            data: {
                locations: [],
                partial: false,
                friendListTimedOut: false,
                timedOutHandles: [],
                skippedFriends: 0
            }
        }
    });
    locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.equal(observations.fallbackCalls, 0, "a complete empty list is a valid helper response");
    assert.deepEqual(locations, []);

    observations = createRefreshScenario({
        helperAvailable: true,
        helperError: new Error("helper failed"),
        fallbackError: new Error("fallback failed")
    });
    locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.equal(observations.helperCalls, 1);
    assert.equal(observations.fallbackCalls, 1);
    assert.equal(locations.length, 1);
    assert.equal(observations.warnings.length, 2, "helper and fallback failures must both be observed");

    FindMyInterface = loadFindMyInterface({ isMinBigSur: true, isMinSonoma: false, isMinSequoia: false });
    observations = createRefreshScenario({
        helperAvailable: true,
        expectedPrivateApiTarget: MESSAGES_PROCESS_IDENTIFIER,
        helperResponse: {
            data: {
                locations: [normalizedLocation],
                partial: false,
                friendListTimedOut: false,
                timedOutHandles: [],
                skippedFriends: 0
            }
        }
    });
    locations = await FindMyInterface.refreshFriends();
    await settleBackgroundFallback();
    assert.deepEqual(observations.privateApiTargets, [MESSAGES_PROCESS_IDENTIFIER]);
    assert.equal(observations.helperCalls, 1, "pre-Sequoia refreshes must continue through the Messages helper");
    assert.equal(observations.fallbackCalls, 1, "legacy refreshes must preserve the existing Find My app refresh");
    assert.equal(locations.length, 1);
};

const runDeviceRefreshTests = async () => {
    FindMyInterface = loadFindMyInterface({ isMinBigSur: true, isMinSonoma: true, isMinSequoia: true });

    let observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: { data: { devices: [], partial: false, skippedDevices: 0 } }
    });
    let devices = await FindMyInterface.getDevices();
    assert.deepEqual(devices, [normalizedOfflineDevice]);
    assert.deepEqual(openedFindMyCommands, [], "GET Devices must not activate or switch the Find My app");
    assert.equal(observations.helperCalls, 0);

    observations = createDeviceRefreshScenario({
        helperResponse: {
            data: {
                devices: [rawDeviceWithLocation, { identifier: "offline-device", batteryLevel: 0 }],
                partial: false,
                skippedDevices: 0
            }
        }
    });
    devices = await FindMyInterface.refreshDevices();
    assert.deepEqual(openedFindMyCommands, ["/usr/bin/open findmy://devices"]);
    assert.equal(observations.helperCalls, 1);
    assert.equal(observations.replacements, 1);
    assert.equal(observations.updates, 0);
    assert.equal(devices.length, 2);
    assert.equal(devices.filter(device => device.location != null).length, 1);

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: {
            data: {
                devices: [rawDeviceWithLocation],
                partial: true,
                skippedDevices: 1
            }
        }
    });
    devices = await FindMyInterface.refreshDevices();
    assert.equal(observations.updates, 1);
    assert.equal(observations.replacements, 0, "a partial snapshot must not remove cached devices");
    assert.equal(observations.warnings.length, 1);
    assert.equal(devices.length, 2);

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: { data: { devices: [], partial: false, skippedDevices: 0 } }
    });
    devices = await FindMyInterface.refreshDevices();
    assert.equal(observations.replacements, 1);
    assert.deepEqual(devices, [], "a complete empty snapshot must clear stale devices");

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: {
            data: {
                devices: [{ identifier: "" }],
                partial: false,
                skippedDevices: 0
            }
        }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /invalid device records/);
    assert.equal(observations.replacements, 0, "an invalid snapshot must preserve the device cache");

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: {
            data: {
                devices: [rawDeviceWithLocation, { identifier: "" }],
                partial: false,
                skippedDevices: 0
            }
        }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /invalid device records/);
    assert.equal(observations.replacements, 0, "a mixed invalid snapshot must preserve the device cache");

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: {
            data: {
                devices: [rawDeviceWithLocation, rawDeviceWithLocation],
                partial: false,
                skippedDevices: 0
            }
        }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /duplicate device identifiers/);
    assert.equal(observations.replacements, 0, "a duplicate snapshot must preserve the device cache");

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: { data: { devices: [], skippedDevices: 0 } }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /invalid completion state/);
    assert.equal(observations.replacements, 0, "an incomplete response contract must preserve the device cache");

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: { data: { devices: [], partial: false, skippedDevices: null } }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /invalid skipped-device count/);
    assert.equal(observations.replacements, 0, "an invalid skipped count must preserve the device cache");

    observations = createDeviceRefreshScenario({
        initialDevices: [normalizedOfflineDevice],
        helperResponse: { data: { devices: [], partial: false, skippedDevices: 1 } }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /inconsistent completion state/);
    assert.equal(observations.replacements, 0, "an inconsistent partial state must preserve the device cache");

    createDeviceRefreshScenario({
        helperAvailable: false,
        helperResponse: { data: { devices: [], partial: false, skippedDevices: 0 } }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /did not connect/);

    createDeviceRefreshScenario({
        privateApiEnabled: false,
        helperResponse: { data: { devices: [], partial: false, skippedDevices: 0 } }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /requires the Private API/);

    createDeviceRefreshScenario({
        openFindMyOnStartup: false,
        helperResponse: { data: { devices: [], partial: false, skippedDevices: 0 } }
    });
    await assert.rejects(() => FindMyInterface.refreshDevices(), /Open FindMy App on Startup/);

    // Verify refresh options forwarding and new-findmy-device emission on location change.
    const sentMessages = [];
    const { PrivateApiFindMy } = loadTypeScriptModule("../src/server/api/privateApi/apis/PrivateApiFindMy.ts", {
        ".": {
            PrivateApiAction: class {
                async sendApiMessage(action, data, _tx, target) {
                    sentMessages.push({ action, data, target });
                    return { data: null };
                }
            }
        },
        "@server/managers/transactionManager/transactionPromise": {
            TransactionPromise: class {
                constructor(type) {
                    this.type = type;
                }
            },
            TransactionType: { FIND_MY: "FIND_MY" }
        },
        "@server/env": { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
        "@server/api/lib/findmy/privateApiSupport": findMyPrivateApiSupport
    });
    const api = new PrivateApiFindMy();
    await api.refreshFriends();
    await api.refreshFriends({ handle: " alice@example.com ", force: true, live: true });
    await api.refreshDevices();
    await api.refreshDevices({ deviceId: " device-1 ", force: true });
    assert.deepEqual(
        sentMessages.map(m => ({ action: m.action, data: m.data })),
        [
            { action: "refresh-findmy-friends", data: null },
            { action: "refresh-findmy-friends", data: { handle: "alice@example.com", force: true, live: true } },
            { action: "refresh-findmy-devices", data: null },
            { action: "refresh-findmy-devices", data: { deviceId: "device-1", force: true } }
        ]
    );

    const emittedDeviceEvents = [];
    const deviceCacheForEvents = new FindMyDevicesCache();
    deviceCacheForEvents.replaceAll([normalizedDeviceWithLocation]);
    const forwardedOptions = [];
    activeServer = {
        repo: {
            getConfig: name => name === "enable_private_api" || name === "open_findmy_on_startup"
        },
        privateApi: {
            hasClient: () => true,
            findmy: {
                refreshFriends: async opts => {
                    forwardedOptions.push({ kind: "friends", opts });
                    return { data: { locations: [normalizedLocation], partial: false } };
                },
                refreshDevices: async opts => {
                    forwardedOptions.push({ kind: "devices", opts });
                    return {
                        data: {
                            devices: [
                                rawDeviceWithLocation,
                                {
                                    ...rawDeviceWithLocation,
                                    identifier: "device-2",
                                    location: { ...rawDeviceWithLocation.location, timeStamp: 9999999 }
                                }
                            ],
                            partial: false,
                            skippedDevices: 0
                        }
                    };
                }
            }
        },
        findMyFriendsCache: new FindMyFriendsCache(),
        findMyDevicesCache: deviceCacheForEvents,
        emitMessage: async (type, data) => {
            emittedDeviceEvents.push({ type, id: data?.identifier ?? data?.id });
        },
        logger: { debug: () => {}, warn: () => {} }
    };

    const bobCachedLocation = { ...normalizedLocation, handle: "bob@example.com" };
    activeServer.findMyFriendsCache.updateAll([bobCachedLocation]);
    await FindMyInterface.refreshFriends(false, { handle: "alice@example.com", force: true, live: true });
    await FindMyInterface.refreshDevices({ deviceId: "device-2", force: true });
    assert.deepEqual(forwardedOptions, [
        { kind: "friends", opts: { handle: "alice@example.com", force: true, live: true } },
        { kind: "devices", opts: { deviceId: "device-2", force: true } }
    ]);
    assert.ok(
        activeServer.findMyFriendsCache.get("bob@example.com") != null,
        "targeted single-friend refresh must preserve other cached friends"
    );
    assert.deepEqual(
        emittedDeviceEvents,
        [{ type: "new-findmy-device", id: "device-2" }],
        "only devices with changed or newly discovered locations should emit new-findmy-device"
    );

    // Verify PrivateApiFindMyEventHandler emits new-findmy-device only on location change.
    const { PrivateApiFindMyEventHandler } = loadTypeScriptModule(
        "../src/server/api/privateApi/eventHandlers/PrivateApiFindMyEventHandler.ts",
        {
            "@server": { Server: () => activeServer },
            net: {},
            ".": {},
            "@server/api/lib/findmy/utils": findMyUtilities,
            "@server/events": {
                NEW_FINDMY_DEVICE: "new-findmy-device",
                NEW_FINDMY_LOCATION: "new-findmy-location"
            },
            "@server/helpers/utils": {
                isEmpty: value => value == null || (typeof value === "string" && value.trim().length === 0),
                titleCase: s => s,
                waitMs: async () => {}
            },
            "@server/lib/logging/Loggable": {
                Loggable: class {
                    constructor() {
                        this.log = { debug: () => {} };
                    }
                }
            },
            "@server/utils/StringUtils": { obfuscatedHandle: h => h }
        }
    );
    emittedDeviceEvents.length = 0;
    const eventHandler = new PrivateApiFindMyEventHandler();
    await eventHandler.handle({
        event: "new-findmy-device",
        data: [
            rawDeviceWithLocation,
            {
                ...rawDeviceWithLocation,
                identifier: "device-2",
                location: { ...rawDeviceWithLocation.location, timeStamp: 10000000 }
            }
        ]
    });
    assert.deepEqual(emittedDeviceEvents, [{ type: "new-findmy-device", id: "device-2" }]);

    // Verify FindMyRouter.refreshFriends forwards live/force/handle and emits targeted new-findmy-location.
    const emittedLocationEvents = [];
    activeServer.emitMessage = async (type, data) => {
        emittedLocationEvents.push({ type, handle: data?.handle });
    };
    const { FindMyRouter } = loadTypeScriptModule("../src/server/api/http/api/v1/routers/findmyRouter.ts", {
        koa: {},
        "koa-router": {},
        "../responses/success": {
            Success: class {
                constructor(_ctx, payload) {
                    this.payload = payload;
                }
                send() {
                    return this.payload;
                }
            }
        },
        "../responses/errors": {
            BadRequest: class extends Error {
                constructor(params) {
                    super(params?.error ?? "BadRequest");
                }
            },
            ServerError: Error
        },
        "@server/api/interfaces/findMyInterface": { FindMyInterface },
        "@server/api/lib/findmy/types": {},
        "@server/events": { NEW_FINDMY_LOCATION: "new-findmy-location" },
        "@server": { Server: () => activeServer }
    });
    forwardedOptions.length = 0;
    const routerResult = await FindMyRouter.refreshFriends(
        { request: { body: { handle: " alice@example.com ", force: true, live: true } } },
        async () => {}
    );
    assert.deepEqual(forwardedOptions, [{ kind: "friends", opts: { handle: "alice@example.com", force: true, live: true } }]);
    assert.deepEqual(emittedLocationEvents, [{ type: "new-findmy-location", handle: "alice@example.com" }]);
    assert.equal(routerResult.data.length, 2);
};

const runLiveModeTests = async () => {
    const { PrivateApiFindMy } = loadTypeScriptModule("../src/server/api/privateApi/apis/PrivateApiFindMy.ts", {
        "@server/env": { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
        "@server/api/lib/findmy/privateApiSupport": {
            resolveFindMyFriendsPrivateApiTarget: () => "com.apple.findmy",
            resolveFindMyDevicesPrivateApiTarget: () => "com.apple.findmy"
        },
        "@server/managers/transactionManager/transactionPromise": {
            TransactionPromise: class {
                constructor(type) {
                    this.type = type;
                }
            },
            TransactionType: { FIND_MY: "FIND_MY" }
        },
        ".": { PrivateApiAction: class {} }
    });

    const sentApiMessages = [];
    const api = new PrivateApiFindMy();
    api.sendApiMessage = async (action, data, _request, target) => {
        sentApiMessages.push({ action, data, target });
        if (action === "start-findmy-live-location") {
            return {
                data: {
                    live: true,
                    locations: [
                        {
                            handle: data.handle,
                            coordinates: [37.3352, -122.0094],
                            status: "live",
                            location_type: 2,
                            horizontal_accuracy: 4.5,
                            vertical_accuracy: 3.0,
                            speed: 2.4,
                            altitude: 18.0,
                            last_updated: 1700000005250,
                            is_locating_in_progress: false
                        }
                    ]
                }
            };
        }
        return { data: { stopped: true } };
    };

    await api.startLiveLocation(" alice@example.com ");
    await api.stopLiveLocation(" alice@example.com ");
    await api.stopLiveLocation();
    assert.deepEqual(sentApiMessages, [
        {
            action: "start-findmy-live-location",
            data: { handle: "alice@example.com" },
            target: "com.apple.findmy"
        },
        {
            action: "stop-findmy-live-location",
            data: { handle: "alice@example.com" },
            target: "com.apple.findmy"
        },
        {
            action: "stop-findmy-live-location",
            data: null,
            target: "com.apple.findmy"
        }
    ]);

    // Verify FindMyFriendsCache detects telemetry refinements at the same timestamp.
    const cache = new FindMyFriendsCache();
    const baseLive = {
        handle: "alice@example.com",
        coordinates: [37.3352, -122.0094],
        status: "live",
        location_type: 2,
        horizontal_accuracy: 15.0,
        vertical_accuracy: 5.0,
        speed: 1.0,
        altitude: 12.0,
        last_updated: 1700000005250,
        is_locating_in_progress: false
    };
    assert.equal(cache.updateAll([baseLive]).length, 1);
    assert.equal(cache.updateAll([{ ...baseLive }]).length, 0);
    assert.equal(
        cache.updateAll([{ ...baseLive, horizontal_accuracy: 4.5, speed: 2.4 }]).length,
        1,
        "live accuracy/speed refinement must not be dropped by FindMyFriendsCache"
    );

    // Verify FindMyInterface.startLiveLocation, idle auto-stop timer, and stopLiveLocation.
    const interfaceEvents = [];
    sentApiMessages.length = 0;
    let activeServer = {
        repo: { getConfig: () => true },
        privateApi: {
            hasClient: () => true,
            findmy: api
        },
        findMyFriendsCache: new FindMyFriendsCache(),
        findMyDevicesCache: { getAll: () => [] },
        emitMessage: async (type, data) => {
            interfaceEvents.push({ type, data });
        },
        logger: { debug: () => {}, warn: () => {} }
    };

    const { FindMyInterface } = loadTypeScriptModule("../src/server/api/interfaces/findMyInterface.ts", {
        "@server": { Server: () => activeServer },
        path,
        fs: { existsSync: () => false },
        "@server/fileSystem": { FileSystem: { findMyDir: "" } },
        "@server/events": { NEW_FINDMY_DEVICE: "new-findmy-device" },
        "@server/env": { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
        "@server/helpers/utils": { waitMs: async () => {} },
        "../apple/scripts": {
            quitFindMyFriends: () => "",
            startFindMyFriends: () => "",
            showFindMyFriends: () => "",
            hideFindMyFriends: () => ""
        },
        "@server/api/lib/findmy/types": {},
        "@server/api/lib/findmy/utils": findMyUtilities,
        "@server/api/lib/findmy/privateApiSupport": {
            resolveFindMyFriendsPrivateApiTarget: () => "com.apple.findmy",
            resolveFindMyDevicesPrivateApiTarget: () => "com.apple.findmy"
        }
    });

    const startRes = await FindMyInterface.startLiveLocation("alice@example.com", { idleTimeoutMs: 25 });
    assert.equal(startRes.live, true);
    assert.equal(startRes.locations.length, 1);
    assert.equal(startRes.locations[0].horizontal_accuracy, 4.5);
    assert.equal(startRes.locations[0].speed, 2.4);
    assert.equal(startRes.locations[0].altitude, 18.0);
    assert.equal(startRes.locations[0].location_type, 2);

    // Wait for idle auto-stop timer to fire automatically.
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(
        sentApiMessages.some(
            msg => msg.action === "stop-findmy-live-location" && msg.data?.handle === "alice@example.com"
        ),
        "idle auto-stop timer must stop live streaming on the helper"
    );

    // Verify PrivateApiFindMyEventHandler preserves all live telemetry fields through socket emit.
    const { PrivateApiFindMyEventHandler } = loadTypeScriptModule(
        "../src/server/api/privateApi/eventHandlers/PrivateApiFindMyEventHandler.ts",
        {
            "@server": { Server: () => activeServer },
            net: {},
            ".": {},
            "@server/api/lib/findmy/utils": findMyUtilities,
            "@server/events": {
                NEW_FINDMY_DEVICE: "new-findmy-device",
                NEW_FINDMY_LOCATION: "new-findmy-location"
            },
            "@server/helpers/utils": {
                isEmpty: value => value == null || (typeof value === "string" && value.trim().length === 0),
                titleCase: s => s,
                waitMs: async () => {}
            },
            "@server/lib/logging/Loggable": {
                Loggable: class {
                    constructor() {
                        this.log = { debug: () => {} };
                    }
                }
            },
            "@server/utils/StringUtils": { obfuscatedHandle: h => h }
        }
    );
    interfaceEvents.length = 0;
    const handler = new PrivateApiFindMyEventHandler();
    await handler.handle({
        event: "new-findmy-location",
        data: [
            {
                handle: "alice@example.com",
                coordinates: [37.3360, -122.0101],
                status: "live",
                location_type: 2,
                horizontal_accuracy: 3.2,
                vertical_accuracy: 2.1,
                speed: 4.8,
                altitude: 22.5,
                last_updated: 1700000009500,
                is_locating_in_progress: false
            }
        ]
    });
    assert.equal(interfaceEvents.length, 1);
    assert.equal(interfaceEvents[0].type, "new-findmy-location");
    assert.equal(interfaceEvents[0].data.status, "live");
    assert.equal(interfaceEvents[0].data.location_type, 2);
    assert.equal(interfaceEvents[0].data.horizontal_accuracy, 3.2);
    assert.equal(interfaceEvents[0].data.vertical_accuracy, 2.1);
    assert.equal(interfaceEvents[0].data.speed, 4.8);
    assert.equal(interfaceEvents[0].data.altitude, 22.5);
    assert.equal(interfaceEvents[0].data.is_locating_in_progress, false);

    // Verify FindMyRouter.startLiveFriend & stopLiveFriend + route registration.
    class MockBadRequest extends Error {
        constructor(params) {
            super(params?.error ?? "BadRequest");
        }
    }
    const { FindMyRouter } = loadTypeScriptModule("../src/server/api/http/api/v1/routers/findmyRouter.ts", {
        koa: {},
        "koa-router": {},
        "../responses/success": {
            Success: class {
                constructor(_ctx, payload) {
                    this.payload = payload;
                }
                send() {
                    return this.payload;
                }
            }
        },
        "../responses/errors": { BadRequest: MockBadRequest, ServerError: Error },
        "@server/api/interfaces/findMyInterface": { FindMyInterface },
        "@server/api/lib/findmy/types": {},
        "@server/events": { NEW_FINDMY_LOCATION: "new-findmy-location" },
        "@server": { Server: () => activeServer }
    });

    await assert.rejects(
        () => FindMyRouter.startLiveFriend({ request: { body: { handle: "  " } } }, async () => {}),
        MockBadRequest
    );
    const routerStart = await FindMyRouter.startLiveFriend(
        { request: { body: { handle: "alice@example.com" } } },
        async () => {}
    );
    assert.equal(routerStart.data.live, true);
    const routerStop = await FindMyRouter.stopLiveFriend(
        { request: { body: { handle: "alice@example.com" } } },
        async () => {}
    );
    assert.equal(routerStop.data.stopped, true);

    const httpRoutesSource = fs.readFileSync(
        path.resolve(__dirname, "../src/server/api/http/api/v1/httpRoutes.ts"),
        "utf8"
    );
    assert.ok(httpRoutesSource.includes('"findmy/friends/live/start"'), "httpRoutes must expose live/start");
    assert.ok(httpRoutesSource.includes('"findmy/friends/live/stop"'), "httpRoutes must expose live/stop");
};

const runAsyncRefreshAndCloudProfileTests = async () => {
    // P1-1: replaceAll must notify onUpdate listeners for updated/new entries
    const replaceCache = new FindMyFriendsCache();
    const notifiedHandles = [];
    replaceCache.onUpdate(loc => notifiedHandles.push(loc.handle));
    replaceCache.replaceAll([
        normalizeFindMyFriendLocation({
            handle: "alice@example.com",
            coordinates: [37.77, -122.41],
            last_updated: 1700000000000,
            status: "shallow",
            is_locating_in_progress: false
        })
    ]);
    assert.deepEqual(notifiedHandles, ["alice@example.com"], "replaceAll must notify onUpdate listeners");

    // P1-2: null and [0,0] coordinate guard preserves cached coordinates, coordinate timestamp, and granular address
    const pinGuardCache = new FindMyFriendsCache();
    const initialPin = normalizeFindMyFriendLocation({
        handle: "alice@example.com",
        coordinates: [37.7824, -122.2165],
        long_address: "3501 Fruitvale Ave, Oakland, CA 94602, United States",
        short_address: "Oakland, CA",
        last_updated: 1700000000000,
        status: "live",
        is_locating_in_progress: false
    });
    pinGuardCache.update(initialPin);

    for (const [idx, badCoords] of [null, [0, 0]].entries()) {
        const updated = pinGuardCache.update({
            ...initialPin,
            coordinates: badCoords,
            long_address: null,
            short_address: null,
            street: null,
            city: null,
            state: null,
            zip: null,
            country: null,
            address: null,
            last_updated: 1700000050000 + idx * 1000,
            status: idx === 0 ? "shallow" : "legacy",
            is_live: false,
            locating_in_progress: idx === 0,
            is_locating_in_progress: idx === 0
        });
        assert.equal(updated, true);
        const preserved = pinGuardCache.get("alice@example.com");
        assert.deepEqual(preserved.coordinates, [37.7824, -122.2165], "must preserve cached coordinates");
        assert.equal(preserved.last_updated, 1700000000000, "must preserve coordinate last_updated");
        assert.equal(preserved.long_address, "3501 Fruitvale Ave, Oakland, CA 94602, United States");
        assert.equal(preserved.street, "3501 Fruitvale Ave");
        assert.equal(preserved.city, "Oakland");
        assert.equal(preserved.locating_in_progress, idx === 0);
        assert.equal(preserved.status, idx === 0 ? "shallow" : "legacy");
        assert.equal(preserved.is_live, false);
    }

    // P1-1: refreshFriends awaits onUpdate ONLY when targeted handle has locating_in_progress === true
    const cache = new FindMyFriendsCache();
    cache.updateAll([
        normalizeFindMyFriendLocation({
            handle: "alice@example.com",
            coordinates: [37.77, -122.41],
            long_address: "San Francisco, CA",
            last_updated: 1700000000000,
            status: "shallow",
            is_locating_in_progress: true
        })
    ]);

    let activeServer = {
        repo: { getConfig: name => name === "enable_private_api" },
        privateApi: {
            hasClient: () => true,
            findmy: {
                refreshFriends: async () => {
                    // Simulate macOS XPC accepting immediately while locating, then pushing fresh fix 40ms later
                    setTimeout(() => {
                        cache.updateAll([
                            normalizeFindMyFriendLocation({
                                handle: "alice@example.com",
                                coordinates: [37.7824, -122.2165],
                                long_address: "3501 Fruitvale Ave, Oakland, CA 94602",
                                short_address: "Oakland, CA",
                                last_updated: 1700000055000,
                                status: "shallow",
                                is_locating_in_progress: false
                            })
                        ]);
                    }, 40);
                    return { data: { locations: cache.getAll(), partial: false } };
                }
            }
        },
        findMyFriendsCache: cache,
        findMyDevicesCache: { getAll: () => [] },
        emitMessage: async () => {},
        logger: { debug: () => {}, warn: () => {} }
    };

    const { FindMyInterface } = loadTypeScriptModule("../src/server/api/interfaces/findMyInterface.ts", {
        "@server": { Server: () => activeServer },
        "@server/fileSystem": { FileSystem: {} },
        "@server/events": { NEW_FINDMY_DEVICE: "new-findmy-device" },
        "@server/env": { isMinBigSur: true, isMinSequoia: true, isMinSonoma: true },
        "@server/helpers/utils": { waitMs: async ms => new Promise(r => setTimeout(r, ms)) },
        "../apple/scripts": {},
        "@server/api/lib/findmy/utils": findMyUtilities,
        "@server/api/lib/findmy/privateApiSupport": findMyPrivateApiSupport
    });

    const refreshed = await FindMyInterface.refreshFriends(false, { handle: "alice@example.com", force: true });
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].last_updated, 1700000055000);
    assert.equal(refreshed[0].street, "3501 Fruitvale Ave");
    assert.equal(refreshed[0].city, "Oakland");
    assert.equal(refreshed[0].is_live, false);

    // P1-1: untargeted and non-locating targeted calls must not stall post-helper
    const untargetedStart = Date.now();
    await FindMyInterface.refreshFriends(false);
    assert.ok(Date.now() - untargetedStart < 200, "untargeted refreshFriends must not stall");

    const cachedTargetStart = Date.now();
    await FindMyInterface.refreshFriends(false, { handle: "alice@example.com" });
    assert.ok(Date.now() - cachedTargetStart < 200, "non-locating targeted refreshFriends must not stall");

    // P1-3 & B3: iCloudInterface non-self isolation, self fallback, memoization, and no duplicate contact card IPC
    let accountInfoIpcCount = 0;
    let contactCardIpcCalls = [];
    let queryContactsCalls = [];
    const mockCloudServer = {
        repo: { getConfig: () => true },
        privateApi: {
            hasClient: () => true,
            flavour: "Messages",
            cloud: {
                getAccountInfo: async () => {
                    accountInfoIpcCount += 1;
                    return {
                        data: {
                            account_name: "Jess Fan",
                            apple_id: "jessefan2002@gmail.com",
                            active_alias: "+16692535118",
                            aliases: [{ Alias: "+16692535118", Status: 5000, IsUserVisible: true }],
                            vetted_aliases: [{ Alias: "+16692535118", Status: 5000, IsUserVisible: true }]
                        }
                    };
                },
                getContactCard: async addr => {
                    contactCardIpcCalls.push(addr);
                    if (addr === "other@example.com") {
                        return { data: { name: null, avatar_path: null } };
                    }
                    return { data: { name: null, avatar_path: null } };
                },
                modifyActiveAlias: async () => ({ data: {} })
            }
        }
    };

    const { iCloudInterface } = loadTypeScriptModule("../src/server/api/interfaces/iCloudInterface.ts", {
        "@server": { Server: () => mockCloudServer },
        "@server/env": { isMinBigSur: true, isMinHighSierra: true },
        "@server/helpers/utils": {
            checkPrivateApiStatus: () => {},
            isNotEmpty: v => v != null && String(v).trim().length > 0
        },
        "./contactInterface": {
            ContactInterface: {
                queryContacts: async ids => {
                    queryContactsCalls.push(ids);
                    return [{ firstName: "Jess", lastName: "Fan", displayName: "Jess Fan", avatar: "AQID" }];
                }
            }
        }
    });

    const acct = await iCloudInterface.getAccountInfo();
    assert.equal(acct.account_name, "Jess Fan");
    assert.equal(acct.first_name, "Jess");
    assert.equal(acct.last_name, "Fan");
    assert.equal(acct.apple_id, "jessefan2002@gmail.com");
    assert.ok(Array.isArray(acct.active_aliases) && acct.active_aliases.includes("+16692535118"));
    assert.equal(accountInfoIpcCount, 1);

    // B3: second getAccountInfo() within TTL hits cache
    await iCloudInterface.getAccountInfo();
    assert.equal(accountInfoIpcCount, 1, "getAccountInfo() must be memoized within 5-min TTL");

    // B3: getContactCard() for self reuses cached accountInfo and makes only 1 getContactCard IPC
    contactCardIpcCalls = [];
    const selfCard = await iCloudInterface.getContactCard();
    assert.equal(selfCard.name, "Jess Fan");
    assert.equal(selfCard.display_name, "Jess Fan");
    assert.equal(selfCard.first_name, "Jess");
    assert.equal(selfCard.last_name, "Fan");
    assert.equal(selfCard.avatar, "AQID");
    assert.equal(contactCardIpcCalls.length, 1, "self getContactCard must not duplicate getContactCard IPC");

    // P1-3: non-self lookup returns ONLY Private API contact card (no AddressBook/NickNameCache fallback)
    const abCallsBeforeNonSelf = queryContactsCalls.length;
    const otherCard = await iCloudInterface.getContactCard("other@example.com");
    assert.equal(otherCard.name, null);
    assert.equal(otherCard.avatar, null);
    assert.equal(
        queryContactsCalls.length,
        abCallsBeforeNonSelf,
        "non-self getContactCard must not query AddressBook"
    );

    // P1-3: self alias lookup keeps full self fallback chain
    const selfAliasCard = await iCloudInterface.getContactCard("+16692535118");
    assert.equal(selfAliasCard.name, "Jess Fan");
    assert.equal(selfAliasCard.avatar, "AQID");

    // B3: invalidateAccountInfoCache / modifyActiveAlias clears memoized account info
    await iCloudInterface.modifyActiveAlias("+16692535118");
    await iCloudInterface.getAccountInfo();
    assert.equal(accountInfoIpcCount, 2, "modifyActiveAlias must invalidate memoized getAccountInfo cache");
};

runFindMyDylibPluginTests()
    .then(runRefreshBranchTests)
    .then(runDeviceRefreshTests)
    .then(runLiveModeTests)
    .then(runAsyncRefreshAndCloudProfileTests)
    .then(() => console.log("PASS: Find My integration tests"))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
