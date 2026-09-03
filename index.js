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

app.patch("/api/client/tasks/:taskId", async (req, res) => {
  try {
    const taskId = oid(req.params.taskId);
    const email = String(req.body.client_email || "")
      .trim()
      .toLowerCase();
    const { tasks } = c();
    const task = taskId && (await tasks.findOne({ _id: taskId }));
    if (!task || task.client_email !== email)
      return error(res, 403, "You do not own this task.");
    if (status(task.status) !== "open")
      return error(res, 409, "Only open tasks can be edited.");
    const update = {};
    ["title", "description", "category", "deadline"].forEach((key) => {
      if (req.body[key] !== undefined)
        update[key] = String(req.body[key]).trim();
    });
    if (req.body.budget !== undefined) update.budget = Number(req.body.budget);
    await tasks.updateOne({ _id: taskId }, { $set: update });
    res.json(await tasks.findOne({ _id: taskId }));
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to update task.");
  }
});

app.delete("/api/client/tasks/:taskId", async (req, res) => {
  try {
    const taskId = oid(req.params.taskId);
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { tasks, proposals } = c();
    const task = taskId && (await tasks.findOne({ _id: taskId }));
    if (!task || task.client_email !== email)
      return error(res, 403, "You do not own this task.");
    if (status(task.status) !== "open")
      return error(res, 409, "Only open tasks can be deleted.");
    if (
      await proposals.findOne({
        task_id: String(taskId),
        status: "accepted",
      })
    )
      return error(
        res,
        409,
        "This task has an approved proposal and cannot be deleted.",
      );
    await tasks.deleteOne({ _id: taskId });
    await proposals.deleteMany({ task_id: String(taskId) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to delete task.");
  }
});

app.get("/api/client/proposals", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { tasks, proposals, users } = c();
    const taskRows = await tasks.find({ client_email: email }).toArray();
    const taskIds = taskRows.map((task) => String(task._id));
    const rows = await proposals
      .find({ task_id: { $in: taskIds } })
      .sort({ submitted_at: -1 })
      .toArray();
    const people = await users
      .find({
        email: { $in: [...new Set(rows.map((row) => row.freelancer_email))] },
      })
      .project({ name: 1, email: 1, image: 1 })
      .toArray();
    const names = Object.fromEntries(
      people.map((person) => [person.email, person]),
    );
    res.json(
      rows.map((row) => ({
        ...row,
        task_title:
          taskRows.find((task) => String(task._id) === String(row.task_id))
            ?.title || "Untitled task",
        freelancer: names[row.freelancer_email] || {
          name: row.freelancer_email,
        },
      })),
    );
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load proposals.");
  }
});

app.patch("/api/client/proposals/:proposalId/reject", async (req, res) => {
  try {
    const proposalId = oid(req.params.proposalId);
    const email = String(req.body.client_email || "")
      .trim()
      .toLowerCase();
    const { proposals, tasks } = c();
    const proposal =
      proposalId && (await proposals.findOne({ _id: proposalId }));
    const task =
      proposal && (await tasks.findOne({ _id: oid(proposal.task_id) }));
    if (
      !proposal ||
      proposal.status !== "pending" ||
      !task ||
      task.client_email !== email
    )
      return error(res, 403, "You cannot change this proposal.");
    await proposals.updateOne(
      { _id: proposalId },
      { $set: { status: "rejected" } },
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to reject proposal.");
  }
});

app.post("/api/client/proposals/:proposalId/accept", async (req, res) => {
  try {
    const proposalId = oid(req.params.proposalId);
    const email = String(req.body.client_email || "")
      .trim()
      .toLowerCase();
    const { proposals, tasks } = c();
    const proposal =
      proposalId && (await proposals.findOne({ _id: proposalId }));
    const task =
      proposal && (await tasks.findOne({ _id: oid(proposal.task_id) }));
    if (
      !proposal ||
      proposal.status !== "pending" ||
      !task ||
      task.client_email !== email
    )
      return error(res, 403, "You cannot change this proposal.");
    if (
      await proposals.findOne({
        task_id: proposal.task_id,
        status: "accepted",
        _id: { $ne: proposalId },
      })
    )
      return error(
        res,
        409,
        "Another proposal is already selected for this task.",
      );
    res.json({
      ok: true,
      taskId: proposal.task_id,
      proposalId: String(proposalId),
      amount: Number(proposal.proposed_budget || task.budget),
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to accept proposal.");
  }
});

app.post("/api/client/payments/confirm", async (req, res) => {
  try {
    const proposalId = oid(req.body.proposalId);
    const email = String(req.body.client_email || "")
      .trim()
      .toLowerCase();
    const { proposals, tasks, payments } = c();
    const proposal =
      proposalId && (await proposals.findOne({ _id: proposalId }));
    const task =
      proposal && (await tasks.findOne({ _id: oid(proposal.task_id) }));
    if (!task || task.client_email !== email || proposal.status !== "pending")
      return error(res, 400, "Payment session is invalid.");
    await proposals.updateMany(
      { task_id: proposal.task_id },
      { $set: { status: "rejected" } },
    );
    await proposals.updateOne(
      { _id: proposalId },
      { $set: { status: "accepted" } },
    );
    await tasks.updateOne(
      { _id: task._id },
      { $set: { status: "in_progress" } },
    );
    const payment = {
      client_email: email,
      freelancer_email: proposal.freelancer_email,
      task_id: proposal.task_id,
      amount: Number(proposal.proposed_budget || task.budget),
      transaction_id: `demo_${Date.now()}`,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
    };
    await payments.insertOne(payment);
    res.json({ ok: true, payment });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to confirm payment.");
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
