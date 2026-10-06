const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const routePath = path.join(__dirname, '../src/routes/packagemaster.js');
const routeRequire = createRequire(routePath);
const source = fs.readFileSync(routePath, 'utf8');

function loadRoute({ storedTimes = [], directTimetype = 1, prescriptionRows = [] } = {}) {
    const inserts = [];
    const queries = [];
    const executeMySql = async (sql, params) => {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT frequencyTime')) {
            return storedTimes.map((frequencyTime) => ({ frequencyTime }));
        }
        if (sql.startsWith('SELECT timetype')) {
            return [{ timetype: directTimetype }];
        }
        if (sql.startsWith('INSERT INTO packagemaster')) {
            const columns = sql.match(/\(([^)]+)\)/)[1].split(', ');
            inserts.push(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
            return {};
        }
        if (sql.includes('FROM\n        prescription')) {
            return prescriptionRows;
        }
        if (sql.startsWith('UPDATE prescription')) return {};
        throw new Error(`Unexpected query: ${sql}`);
    };
    const context = {
        require: (name) => name === '../db/mysqlPool' ? { executeMySql } : routeRequire(name),
        module: { exports: {} },
        __dirname: path.dirname(routePath),
        process,
        console: { log() {}, error() {} },
        Buffer
    };
    vm.runInNewContext(`${source}\nmodule.exports = { insertPackageMasterRow, buildPackageMasterRow, executeSendByPres };`, context, { filename: routePath });
    return { ...context.module.exports, inserts, queries };
}

function prescription(overrides = {}) {
    return {
        prescriptionno: 'RX1',
        seq: 1,
        an: 'AN1',
        hn: 'HN1',
        orderitemcode: 'D1',
        takedate: '2026-10-06',
        ordercreatedate: '2026-10-06',
        timedetailcode: '0001',
        timedetailTH: 'Original description',
        timecode: 'TYPE1',
        timetype: 1,
        sendmachine: 'y',
        ...overrides
    };
}

test('type-1 JVM rows share a per-AN sequence with existing PRN values', async () => {
    const route = loadRoute({ storedTimes: ['2201', '2205'] });
    const frequencyCounters = new Map();
    for (const type of [1, '1', 1]) {
        const row = route.buildPackageMasterRow(prescription({ timetype: type }), 0, 3, new Date('2026-10-06'), null);
        await route.insertPackageMasterRow(row, { timetype: type, frequencyCounters });
    }
    assert.deepEqual(route.inserts.map((row) => row.frequencyTime), ['2206', '2207', '2208']);
    assert.ok(route.inserts.every((row) => row.frequencyTimedesc === 'Original description'));
    assert.equal(route.queries.filter(({ sql }) => sql.startsWith('SELECT frequencyTime')).length, 1);
});

test('different ANs start independent counters and use the actual AN for lookup', async () => {
    const route = loadRoute();
    const frequencyCounters = new Map();
    for (const an of ['AN1', 'AN2', 'AN1']) {
        await route.insertPackageMasterRow({ an, locationcode: '2', frequencyTime: '2259' }, {
            timetype: 1, frequencyCounters
        });
    }
    assert.deepEqual(route.inserts.map((row) => row.frequencyTime), ['2201', '2201', '2202']);
    assert.deepEqual(route.queries.filter(({ sql }) => sql.startsWith('SELECT frequencyTime')).map(({ params }) => params[0]), ['AN1', 'AN2']);
});

test('resolved frontend JVM override receives a separate time', async () => {
    const route = loadRoute();
    const row = route.buildPackageMasterRow(prescription({ sendmachine: 'n', shelfzone: 'LED' }), 0, 1, new Date('2026-10-06'), { shelfname: 'JVM01' });
    await route.insertPackageMasterRow(row, { timetype: 1 });
    assert.equal(route.inserts[0].locationcode, '2');
    assert.equal(route.inserts[0].frequencyTime, '2201');
});

test('non-JVM rows and other time types retain their built times', async () => {
    const route = loadRoute();
    for (const [type, shelfname] of [[1, 'LED01'], [1, 'HAD01'], [2, 'JVM01'], [4, 'JVM01']]) {
        const row = route.buildPackageMasterRow(prescription({ timetype: type, timedetailcode: '0800', shelfzone: 'JVM', shelfname: 'JVM' }), 0, 1, new Date('2026-10-06'), { shelfname });
        const originalTime = row.frequencyTime;
        await route.insertPackageMasterRow(row, { timetype: type });
        assert.equal(route.inserts.at(-1).frequencyTime, originalTime);
    }
    assert.equal(route.queries.filter(({ sql }) => sql.startsWith('SELECT frequencyTime')).length, 0);
});

test('legacy PRN and type-1 rows share a counter while PRN keeps its description', async () => {
    const route = loadRoute();
    const frequencyCounters = new Map();
    await route.insertPackageMasterRow({ an: 'AN1', locationcode: '2', timecode: 'prn' }, {
        timetype: 4, separatePrn: true, frequencyCounters
    });
    await route.insertPackageMasterRow({ an: 'AN1', locationcode: '2' }, {
        timetype: 1, frequencyCounters
    });
    assert.deepEqual(route.inserts.map((row) => row.frequencyTime), ['2201', '2202']);
    assert.equal(route.inserts[0].frequencyTimedesc, 'PRN');
});

test('direct JVM inserts look up timetype from ms_time before insertion', async () => {
    const route = loadRoute({ storedTimes: ['2209'] });
    await route.insertPackageMasterRow({ an: 'AN1', locationcode: '2', timecode: 'TYPE1', frequencyTime: '2259' });
    assert.equal(route.inserts[0].frequencyTime, '2210');
    const lookup = route.queries.find(({ sql }) => sql.startsWith('SELECT timetype'));
    assert.equal(lookup.params[0], 'TYPE1');
});

test('direct JVM inserts for other time types retain their time', async () => {
    const route = loadRoute({ directTimetype: 2 });
    await route.insertPackageMasterRow({ an: 'AN1', shelfzone: 'JVM', timecode: 'TYPE2', frequencyTime: '2359' });
    assert.equal(route.inserts[0].frequencyTime, '2359');
});

test('missing AN is reported instead of inserting a type-1 JVM row', async () => {
    const route = loadRoute();
    await assert.rejects(route.insertPackageMasterRow({ locationcode: '2' }, { timetype: 1 }), /an is required/);
    assert.equal(route.inserts.length, 0);
});

test('send-by-prescription allocates type-1 JVM times when selected by HN', async () => {
    const route = loadRoute({
        storedTimes: ['2202'],
        prescriptionRows: [prescription(), prescription({ seq: 2, orderitemcode: 'D2' })]
    });
    const results = await route.executeSendByPres({ ans: ['HN1'] });
    assert.equal(results[0].recordCount, 2);
    assert.deepEqual(route.inserts.map((row) => row.frequencyTime), ['2203', '2204']);
    const lookup = route.queries.find(({ sql }) => sql.startsWith('SELECT frequencyTime'));
    assert.equal(lookup.params[0], 'AN1');
});
