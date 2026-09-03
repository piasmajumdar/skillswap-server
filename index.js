const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const app = express();
const port = Number(process.env.PORT || 8000);
const mongo = new MongoClient(process.env.MONGO_DB_URI);
let db;

app.use(cors());
app.use(express.json());

const c = () => ({
  tasks: db.collection("tasks"),
  proposals: db.collection("proposals"),
  users: db.collection("user"),
  payments: db.collection("payment"),
});
const oid = (value) => {
  try {
    return new ObjectId(value);
  } catch {
    return null;
  }
};
const status = (value) =>
  String(value || "open")
    .toLowerCase()
    .replace(/[- ]/g, "_");
const error = (res, code, message) => res.status(code).json({ error: message });

app.get("/", (req, res) => res.json({ ok: true, service: "skillswap-server" }));

app.get("/api/client/dashboard", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) return error(res, 400, "Client email is required.");
    const { tasks, proposals, payments } = c();
    const taskRows = await tasks
      .find({ client_email: email })
      .sort({ createdAt: -1 })
      .toArray();
    const taskIds = taskRows.map((task) => String(task._id));
    res.json({
      tasks: taskRows,
      proposals: await proposals.find({ task_id: { $in: taskIds } }).toArray(),
      payments: await payments.find({ client_email: email }).toArray(),
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load dashboard data.");
  }
});
app.get("/api/client/tasks", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) return error(res, 400, "Client email is required.");
    res.json(
      await c()
        .tasks.find({ client_email: email })
        .sort({ createdAt: -1 })
        .toArray(),
    );
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load tasks.");
  }
});


app.post("/api/client/tasks", async (req, res) => {
  try {
    const { title, description, category, budget, deadline, client_email } =
      req.body;
    const email = String(client_email || "")
      .trim()
      .toLowerCase();
    if (
      !title ||
      !description ||
      !category ||
      !deadline ||
      !email ||
      Number(budget) <= 0
    )
      return error(res, 400, "All task fields are required.");
    const task = {
      title: String(title).trim(),
      description: String(description).trim(),
      category: String(category).trim(),
      budget: Number(budget),
      deadline: new Date(deadline).toISOString(),
      client_email: email,
      status: "open",
      deliverable_url: null,
      createdAt: new Date().toISOString(),
    };
    const result = await c().tasks.insertOne(task);
    res.status(201).json({ ...task, _id: result.insertedId });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to create task.");
  }
});

app.get("/api/client/profile", async (req, res) => {
  try {
    res.json(
      (await c().users.findOne(
        {
          email: String(req.query.email || "")
            .trim()
            .toLowerCase(),
        },
        { projection: { password: 0 } },
      )) || {},
    );
  } catch (e) {
    error(res, 500, "Unable to load profile.");
  }
});
app.patch("/api/client/profile", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    await c().users.updateOne(
      { email },
      {
        $set: {
          name: String(req.body.name || "").trim(),
          image: String(req.body.image || "").trim(),
          updatedAt: new Date(),
        },
      },
    );
    res.json(
      await c().users.findOne({ email }, { projection: { password: 0 } }),
    );
  } catch (e) {
    error(res, 500, "Unable to update profile.");
  }
});


async function start() {
  await mongo.connect();
  db = mongo.db("skillswap");
  await db.command({ ping: 1 });
  console.log("Connected to MongoDB");
  app.listen(port, () => console.log(`SkillSwap API listening on ${port}`));
}
start().catch((e) => {
  console.error(e);
  process.exit(1);
});
