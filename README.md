# Interface API

Simple Express API connected to SQL Server.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Update `.env` if needed.

3. Start the server:

   ```bash
   npm run dev
   ```

## Endpoints

- `GET /`
- `GET /health`
- `GET /api/db-test`
- `POST /api/users`
- `POST /api/users/:userID`
- `POST /api/users/create`
- `POST /api/prescriptions`
- `POST /api/prescriptions/ward-summary`
- `POST /api/prescriptions/:prescriptionno`
- `PUT /api/users/:userID`
- `DELETE /api/users/:userID`

## Test Tools

- API guide: `/tools/`
- Web tester: `/tools/tester.html`
- Postman collection: `/tools/postman/Interface_api.postman_collection.json`
- Postman environment: `/tools/postman/Interface_api.local.postman_environment.json`

## How To Open The Web Page

1. Start the API server:

   ```bash
   npm start
   ```

2. Open the browser with one of these URLs:

   - `http://localhost:5050/tools/`
   - `http://localhost:5050/tools/tester.html`
   - `http://192.168.19.249:5050/tools/` (server)

3. The Web Tester uses the URL currently open in the browser. For Postman, import either the Local or Server environment to select the target API.

## Example Body

```json
{
   "username": "1",
   "password": "1",
   "userbarcode": "1"
}
```

You can also import `public/postman/Interface_api.postman_collection.json` into Postman directly.

## Send JSON File To Read Data

The routes below also support uploading a `.json` file in `form-data` using the field name `file`:

- `POST /api/users`
- `POST /api/users/:userID`

Example file content for filtering by `userID`:

```json
{
   "username": "1",
   "password": "1",
   "userbarcode": "1"
}
```

In Postman:

1. Choose `POST /api/users` or `POST /api/users/:userID`
2. Open `Body`
3. Select `form-data`
4. Create key `file`
5. Change the key type from `Text` to `File`
6. Select a `.json` file

Sample file: `examples/user-filter.json`

## Prescription Example Body

```json
{
   "prescriptionno": "RX0001",
   "hn": "123456",
   "an": "654321",
   "orderitembarcode": "ITEM001"
}
```

The routes below also support uploading a `.json` file in `form-data` using the field name `file`:

- `POST /api/prescriptions`
- `POST /api/prescriptions/ward-summary`
- `POST /api/prescriptions/:prescriptionno`

Sample file: `examples/prescription-filter.json`

## Prescription Ward Summary Example Body

```json
{
   "startDate": "2024-10-30 00:00:00",
   "endDate": "2024-10-30 23:59:59",
   "wardcode": "03",
   "genorderdatetimeIsNull": true
}
```

This route summarizes total orders by ward and order date.

Sample file: `examples/prescription-ward-summary-filter.json`

## JVM Separate Packages

Before inserting into `packagemaster`, medications routed to JVM with
`ms_time.timetype = 1` receive a separate `frequencyTime` from the existing
PRN sequence: `2201`, `2202`, `2203`, and so on. The sequence continues from
the highest stored `22`-prefixed value for the actual AN, including when
orders are selected by HN or JVM is selected through the medication shelf
override. PRN and other type-1 JVM rows share the same counter.

This applies to send-by-prescription requests and direct `items` inserts
through `POST /api/packagemaster`. Direct JVM items use their `timecode` to
look up `ms_time.timetype`. Other time types and non-JVM medications retain
their existing behavior.
