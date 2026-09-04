const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");
const Stripe = require("stripe");

dotenv.config();
const app = express();
const port = Number(process.env.PORT || 8000);
const mongo = new MongoClient(process.env.MONGO_DB_URI);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
let db;

app.use(cors());
app.use(express.json());

const c = () => ({
  tasks: db.collection("tasks"),
  proposals: db.collection("proposals"),
  users: db.collection("user"),
  payments: db.collection("payments"),
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

app.get("/api/auth/account-status", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    const user = await c().users.findOne(
      { email },
      { projection: { email: 1, isBlocked: 1, role: 1 } },
    );
    res.json({ exists: Boolean(user), isBlocked: Boolean(user?.isBlocked), role: user?.role || null });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to verify account status.");
  }
});

app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const { users, tasks, payments } = c();
    const [userRows, taskRows, paymentRows] = await Promise.all([
      users.find({}).project({ name: 1, email: 1, role: 1, image: 1, createdAt: 1, isBlocked: 1 }).toArray(),
      tasks.find({}).sort({ createdAt: -1 }).toArray(),
      payments.find({ payment_status: "paid" }).sort({ paid_at: -1 }).limit(8).toArray(),
    ]);
    const roleCounts = userRows.reduce((counts, user) => {
      const role = String(user.role || "unknown").toLowerCase();
      counts[role] = (counts[role] || 0) + 1;
      return counts;
    }, {});
    const statusCounts = taskRows.reduce((counts, task) => {
      const taskStatus = task.status || "open";
      counts[taskStatus] = (counts[taskStatus] || 0) + 1;
      return counts;
    }, {});
    res.json({
      totalUsers: userRows.length,
      totalTasks: taskRows.length,
      activeTasks: taskRows.filter((task) => task.status === "open" || task.status === "in_progress").length,
      totalRevenue: paymentRows.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      roleCounts,
      statusCounts,
      recentPayments: paymentRows,
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load admin dashboard.");
  }
});

app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await c().users.find({}).project({ password: 0 }).sort({ createdAt: -1 }).toArray();
    res.json({ users });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load users.");
  }
});

app.patch("/api/admin/users/:userId/block", async (req, res) => {
  try {
    const userId = oid(req.params.userId);
    const isBlocked = Boolean(req.body.isBlocked);
    if (!userId) return error(res, 400, "A valid user ID is required.");
    await c().users.updateOne({ _id: userId }, { $set: { isBlocked, updatedAt: new Date() } });
    res.json(await c().users.findOne({ _id: userId }, { projection: { password: 0 } }));
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to update user access.");
  }
});

app.get("/api/admin/tasks", async (req, res) => {
  try {
    const { tasks, users, proposals } = c();
    const taskRows = await tasks.find({}).sort({ createdAt: -1 }).toArray();
    const clients = await users.find({ email: { $in: taskRows.map((task) => task.client_email) } }).project({ name: 1, email: 1 }).toArray();
    const clientMap = Object.fromEntries(clients.map((client) => [client.email, client]));
    const proposalCounts = await proposals.aggregate([
      { $group: { _id: "$task_id", count: { $sum: 1 } } },
    ]).toArray();
    const countMap = Object.fromEntries(proposalCounts.map((item) => [String(item._id), item.count]));
    res.json({ tasks: taskRows.map((task) => ({
      ...task,
      client: clientMap[task.client_email] || { name: task.client_email },
      proposalCount: countMap[String(task._id)] || 0,
    })) });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load tasks.");
  }
});

app.delete("/api/admin/tasks/:taskId", async (req, res) => {
  try {
    const taskId = oid(req.params.taskId);
    const { tasks, proposals } = c();
    const task = taskId && (await tasks.findOne({ _id: taskId }));
    if (!task) return error(res, 404, "Task not found.");
    if (task.status !== "open") return error(res, 409, "Only open tasks can be deleted.");
    await tasks.deleteOne({ _id: taskId });
    await proposals.deleteMany({ task_id: String(taskId) });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to delete task.");
  }
});

app.get("/api/admin/payments", async (req, res) => {
  try {
    const { payments, tasks, users } = c();
    const paymentRows = await payments.find({ payment_status: "paid" }).sort({ paid_at: -1 }).toArray();
    const taskRows = await tasks.find({ _id: { $in: paymentRows.map((row) => oid(row.task_id)).filter(Boolean) } }).toArray();
    const people = await users.find({ email: { $in: paymentRows.flatMap((row) => [row.client_email, row.freelancer_email]) } }).project({ name: 1, email: 1 }).toArray();
    const taskMap = Object.fromEntries(taskRows.map((task) => [String(task._id), task]));
    const peopleMap = Object.fromEntries(people.map((person) => [person.email, person]));
    res.json({ payments: paymentRows.map((payment) => ({
      ...payment,
      task: taskMap[String(payment.task_id)] || null,
      client: peopleMap[payment.client_email] || null,
      freelancer: peopleMap[payment.freelancer_email] || null,
    })) });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load payment history.");
  }
});

app.get("/api/freelancer/dashboard", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    if (!email) return error(res, 400, "Freelancer email is required.");
    const { proposals, tasks, payments } = c();
    const proposalRows = await proposals
      .find({ freelancer_email: email })
      .sort({ submitted_time: -1, submitted_at: -1 })
      .toArray();
    const taskIds = [
      ...new Set(proposalRows.map((row) => String(row.task_id))),
    ];
    const taskRows = await tasks
      .find({ _id: { $in: taskIds.map(oid).filter(Boolean) } })
      .toArray();
    const taskMap = Object.fromEntries(
      taskRows.map((task) => [String(task._id), task]),
    );
    const completedTaskIds = taskRows
      .filter((task) => task.status === "completed")
      .map((task) => String(task._id));
    const paymentRows = await payments
      .find({ freelancer_email: email, payment_status: "paid" })
      .toArray();
    res.json({
      proposals: proposalRows,
      tasks: taskRows,
      completed: completedTaskIds,
      payments: paymentRows,
      taskMap,
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load freelancer dashboard.");
  }
});

app.get("/api/freelancer/tasks", async (req, res) => {
  try {
    const { tasks, users, proposals } = c();
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 9)
      : 9;
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "").trim().toLowerCase();
    const filter = { status: "open" };

    if (search) {
      filter.title = {
        $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }

    if (category && category !== "all") {
      filter.category = category;
    }

    const total = await tasks.countDocuments(filter);
    const taskRows = await tasks
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    const clientEmails = [
      ...new Set(taskRows.map((task) => task.client_email)),
    ];
    const people = await users
      .find({ email: { $in: clientEmails } })
      .project({ name: 1, email: 1, image: 1 })
      .toArray();
    const clients = Object.fromEntries(
      people.map((person) => [person.email, person]),
    );
    const freelancerEmail = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const proposalRows = freelancerEmail
      ? await proposals
          .find({
            freelancer_email: freelancerEmail,
            task_id: { $in: taskRows.map((task) => String(task._id)) },
          })
          .toArray()
      : [];
    const submitted = new Set(proposalRows.map((row) => String(row.task_id)));
    res.json({
      tasks: taskRows.map((task) => ({
        ...task,
        client: clients[task.client_email] || { name: task.client_email },
        hasSubmittedProposal: submitted.has(String(task._id)),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load tasks.");
  }
});

app.get("/api/freelancer/tasks/:taskId", async (req, res) => {
  try {
    const taskId = oid(req.params.taskId);
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { tasks, proposals, users } = c();
    const task =
      taskId && (await tasks.findOne({ _id: taskId, status: "open" }));
    if (!task) return error(res, 404, "Task not found.");
    const client = await users.findOne(
      { email: task.client_email },
      { projection: { name: 1, email: 1, image: 1 } },
    );
    const proposal = await proposals.findOne({
      task_id: String(taskId),
      freelancer_email: email,
    });
    res.json({
      task,
      client: client || { name: task.client_email },
      proposal,
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load task details.");
  }
});

app.post("/api/freelancer/proposals", async (req, res) => {
  try {
    const {
      task_id,
      freelancer_email,
      proposed_budget,
      estimated_days,
      cover_note,
    } = req.body;
    const taskId = oid(task_id);
    const email = String(freelancer_email || "")
      .trim()
      .toLowerCase();
    const { tasks, proposals } = c();
    const task = taskId && (await tasks.findOne({ _id: taskId }));
    if (!task || task.status !== "open")
      return error(res, 409, "Only open tasks accept proposals.");
    if (
      !email ||
      !cover_note ||
      Number(proposed_budget) <= 0 ||
      Number(estimated_days) <= 0
    )
      return error(res, 400, "All proposal fields are required.");
    if (
      await proposals.findOne({
        task_id: String(taskId),
        freelancer_email: email,
      })
    )
      return error(
        res,
        409,
        "You have already submitted a proposal for this task.",
      );
    const proposal = {
      task_id: String(taskId),
      freelancer_email: email,
      proposed_budget: Number(proposed_budget),
      estimated_days: Number(estimated_days),
      cover_note: String(cover_note).trim(),
      status: "pending",
      submitted_time: new Date().toISOString(),
    };
    const result = await proposals.insertOne(proposal);
    res.status(201).json({ ...proposal, _id: result.insertedId });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to submit proposal.");
  }
});

app.get("/api/freelancer/proposals", async (req, res) => {
  try {
    const email = String(req.query.freelancerEmail || "")
      .trim()
      .toLowerCase();
    if (!email) return error(res, 400, "Freelancer email is required.");
    const { proposals, tasks, users } = c();
    const rows = await proposals
      .find({ freelancer_email: email })
      .sort({ submitted_time: -1, submitted_at: -1 })
      .toArray();
    const taskRows = await tasks
      .find({
        _id: { $in: rows.map((row) => oid(row.task_id)).filter(Boolean) },
      })
      .toArray();
    const clients = await users
      .find({ email: { $in: taskRows.map((task) => task.client_email) } })
      .project({ name: 1, email: 1, image: 1 })
      .toArray();
    const taskMap = Object.fromEntries(
      taskRows.map((task) => [String(task._id), task]),
    );
    const clientMap = Object.fromEntries(
      clients.map((client) => [client.email, client]),
    );
    res.json(
      rows.map((row) => ({
        ...row,
        task: taskMap[String(row.task_id)],
        client: clientMap[taskMap[String(row.task_id)]?.client_email] || null,
      })),
    );
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load proposals.");
  }
});

app.get("/api/freelancer/projects", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { proposals, tasks, users, payments } = c();
    const accepted = await proposals
      .find({
        freelancer_email: email,
        status: "accepted",
      })
      .toArray();
    const acceptedMap = Object.fromEntries(
      accepted.map((proposal) => [String(proposal.task_id), proposal]),
    );
    const taskRows = await tasks
      .find({
        _id: { $in: accepted.map((row) => oid(row.task_id)).filter(Boolean) },
        status: { $in: ["in_progress", "completed"] },
      })
      .toArray();
    const clients = await users
      .find({
        email: { $in: taskRows.map((task) => task.client_email) },
      })
      .project({ name: 1, email: 1, image: 1 })
      .toArray();
    const clientMap = Object.fromEntries(
      clients.map((client) => [client.email, client]),
    );
    const paymentRows = await payments
      .find({
        freelancer_email: email,
        payment_status: "paid",
      })
      .toArray();
    const paymentMap = Object.fromEntries(
      paymentRows.map((payment) => [String(payment.task_id), payment]),
    );
    res.json(
      taskRows.map((task) => ({
        ...task,
        client: clientMap[task.client_email] || { name: task.client_email },
        payment: paymentMap[String(task._id)] || null,
        proposal: acceptedMap[String(task._id)] || null,
      })),
    );
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load active projects.");
  }
});

app.patch("/api/freelancer/projects/:taskId/deliverable", async (req, res) => {
  try {
    const taskId = oid(req.params.taskId);
    const email = String(req.body.freelancer_email || "")
      .trim()
      .toLowerCase();
    const deliverableUrl = String(req.body.deliverable_url || "").trim();
    const { tasks, proposals } = c();
    const task = taskId && (await tasks.findOne({ _id: taskId }));
    const accepted =
      task &&
      (await proposals.findOne({
        task_id: String(taskId),
        freelancer_email: email,
        status: "accepted",
      }));
    if (!task || !accepted)
      return error(res, 403, "You cannot submit a deliverable for this task.");
    if (!deliverableUrl)
      return error(res, 400, "A deliverable URL is required.");
    await tasks.updateOne(
      { _id: taskId },
      { $set: { deliverable_url: deliverableUrl, status: "completed" } },
    );
    res.json(await tasks.findOne({ _id: taskId }));
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to submit deliverable.");
  }
});

app.get("/api/freelancer/earnings", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { payments, tasks, users } = c();
    const paymentRows = await payments
      .find({
        freelancer_email: email,
        payment_status: "paid",
      })
      .sort({ paid_at: -1 })
      .toArray();
    const taskRows = await tasks
      .find({
        _id: {
          $in: paymentRows.map((row) => oid(row.task_id)).filter(Boolean),
        },
      })
      .toArray();
    const clients = await users
      .find({
        email: { $in: taskRows.map((task) => task.client_email) },
      })
      .project({ name: 1, email: 1 })
      .toArray();
    const taskMap = Object.fromEntries(
      taskRows.map((task) => [String(task._id), task]),
    );
    const clientMap = Object.fromEntries(
      clients.map((client) => [client.email, client]),
    );
    res.json(
      paymentRows.map((payment) => ({
        ...payment,
        task: taskMap[String(payment.task_id)],
        client:
          clientMap[taskMap[String(payment.task_id)]?.client_email] || null,
      })),
    );
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load earnings.");
  }
});

app.get("/api/freelancer/profile", async (req, res) => {
  try {
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    res.json(
      (await c().users.findOne({ email }, { projection: { password: 0 } })) ||
        {},
    );
  } catch (e) {
    error(res, 500, "Unable to load profile.");
  }
});

app.patch("/api/freelancer/profile", async (req, res) => {
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
          skills: String(req.body.skills || "").trim(),
          bio: String(req.body.bio || "").trim(),
          hourlyRate: Number(req.body.hourlyRate || 0),
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

app.get("/api/client/tasks/:taskId", async (req, res) => {
  try {
    const taskId = oid(req.params.taskId);
    const email = String(req.query.email || "")
      .trim()
      .toLowerCase();
    const { tasks, proposals, users } = c();
    const task = taskId && (await tasks.findOne({ _id: taskId }));

    if (!task || task.client_email !== email) {
      return error(res, 403, "You do not own this task.");
    }

    const proposalRows = await proposals
      .find({ task_id: String(taskId) })
      .sort({ submitted_time: -1, submitted_at: -1 })
      .toArray();
    const emails = [
      ...new Set(proposalRows.map((row) => row.freelancer_email)),
    ];
    const people = await users
      .find({ email: { $in: emails } })
      .project({ name: 1, email: 1, image: 1 })
      .toArray();
    const freelancers = Object.fromEntries(
      people.map((person) => [person.email, person]),
    );

    res.json({
      task,
      proposals: proposalRows.map((proposal) => ({
        ...proposal,
        freelancer: freelancers[proposal.freelancer_email] || {
          name: proposal.freelancer_email,
        },
      })),
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to load task details.");
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
      category: String(category).trim().toLowerCase(),
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
        task_status:
          taskRows.find((task) => String(task._id) === String(row.task_id))
            ?.status || "open",
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
      task.client_email !== email ||
      task.status !== "open"
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
      task.client_email !== email ||
      task.status !== "open"
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

app.post("/api/client/payments/create-checkout-session", async (req, res) => {
  try {
    const proposalId = oid(req.body.proposalId);
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
      task.client_email !== email ||
      task.status !== "open"
    ) {
      return error(
        res,
        409,
        "This proposal is no longer available for payment.",
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const amount = Math.round(Number(proposal.proposed_budget) * 100);
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: {
              name: task.title,
              description: "SkillSwap freelancer task payment",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        proposalId: String(proposal._id),
        taskId: String(task._id),
        clientEmail: email,
        freelancerEmail: proposal.freelancer_email,
      },
      success_url:
        frontendUrl + "/payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: frontendUrl + "/dashboard/client/proposals",
    });

    res.json({ url: checkoutSession.url, sessionId: checkoutSession.id });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to create Stripe checkout session.");
  }
});

app.post("/api/client/payments/confirm-session", async (req, res) => {
  try {
    const sessionId = String(req.body.session_id || "").trim();
    if (!sessionId) return error(res, 400, "Stripe session ID is required.");

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      checkoutSession.mode !== "payment" ||
      checkoutSession.status !== "complete" ||
      checkoutSession.payment_status !== "paid"
    ) {
      return error(res, 402, "Stripe payment has not been completed.");
    }

    const metadata = checkoutSession.metadata || {};
    const proposalId = oid(metadata.proposalId);
    const taskId = oid(metadata.taskId);
    const { proposals, tasks, payments, users } = c();
    const transactionId = checkoutSession.payment_intent || checkoutSession.id;
    const existingPayment = await payments.findOne({
      transaction_id: transactionId,
    });

    if (existingPayment) {
      const existingTask = await tasks.findOne({
        _id: oid(existingPayment.task_id),
      });
      const existingFreelancer = await users.findOne({
        email: existingPayment.freelancer_email,
      });
      return res.json({
        ok: true,
        alreadyConfirmed: true,
        payment: existingPayment,
        task: existingTask,
        freelancer: existingFreelancer,
      });
    }

    const proposal =
      proposalId && (await proposals.findOne({ _id: proposalId }));
    const task = taskId && (await tasks.findOne({ _id: taskId }));
    if (
      !proposal ||
      !task ||
      proposal.task_id !== String(task._id) ||
      task.client_email !== metadata.clientEmail ||
      proposal.freelancer_email !== metadata.freelancerEmail ||
      proposal.status !== "pending" ||
      task.status !== "open"
    ) {
      return error(
        res,
        409,
        "Stripe session does not match an active proposal.",
      );
    }

    await proposals.updateMany(
      { task_id: String(task._id) },
      { $set: { status: "rejected" } },
    );
    await proposals.updateOne(
      { _id: proposal._id },
      { $set: { status: "accepted" } },
    );
    await tasks.updateOne(
      { _id: task._id },
      { $set: { status: "in_progress" } },
    );

    const payment = {
      client_email: task.client_email,
      freelancer_email: proposal.freelancer_email,
      task_id: String(task._id),
      amount: Number(checkoutSession.amount_total || 0) / 100,
      transaction_id: transactionId,
      payment_status: "paid",
      paid_at: new Date().toISOString(),
    };
    await payments.insertOne(payment);
    const freelancer = await users.findOne({
      email: proposal.freelancer_email,
    });
    res.json({
      ok: true,
      payment,
      task: { ...task, status: "in_progress" },
      freelancer,
    });
  } catch (e) {
    console.error(e);
    error(res, 500, "Unable to confirm Stripe payment.");
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
