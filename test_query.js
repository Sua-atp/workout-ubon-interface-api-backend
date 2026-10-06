const { executeMySql } = require('./src/db/mysqlPool');
const { sendOrderSelectQuery } = require('./src/db/queries/sendOrder');

async function test() {
    const q3 = `${sendOrderSelectQuery} WHERE prescription.an = '000058342'
      AND (prescription.genorderdatetime IS NULL OR prescription.genorderdatetime = '0000-00-00 00:00:00')
      AND (prescription.voiddatetime IS NULL OR prescription.voiddatetime = '0000-00-00 00:00:00')
      AND UPPER(COALESCE(ms_drug.sendmachine, prescription.sendmachine)) = 'Y'`;
    const r3 = await executeMySql(q3);
    console.log('r3 count (with COALESCE sendmachine = Y):', r3.length);

    process.exit(0);
}
test();
