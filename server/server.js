const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const cron = require("node-cron");
const stripe = require("stripe");
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { put, del } = require("@vercel/blob");

dotenv.config();

const app = express();

// Configure multer for file uploads
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "video/mp4",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Unsupported file type. Allowed: JPG, PNG, MP4, PDF, DOC, DOCX"
        )
      );
    }
  },
});

const discordClient = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let isDiscordReady = false;
discordClient.once("ready", () => {
  console.log(`Logged in to Discord as ${discordClient.user.tag}`);
  isDiscordReady = true;
});

discordClient.on("debug", (info) => {
  console.log(`Discord debug: ${info}`);
});

// Handle DMs to store user IDs
discordClient.on("messageCreate", async (message) => {
  console.log("MessageCreate event triggered");

  if (message.author.bot || !message.channel.isDMBased()) {
    console.log("Ignoring message: from bot or not a DM");
    return;
  }

  const userDiscordId = message.author.id;
  const userMessage = message.content.trim();
  console.log(`Received DM from Discord user ${userDiscordId}: ${userMessage}`);

  // Check if the message contains an email-like string
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const cleanedMessage = userMessage.replace(/\s+/g, "").toLowerCase();
  let userEmail = cleanedMessage;

  if (userEmail === "deepgonadliya773@gmail.com") {
    userEmail = "deepgondaliya773@gmail.com";
    console.log(
      `Corrected email typo: deepgonadliya773@gmail.com to ${userEmail}`
    );
  }

  if (emailRegex.test(userEmail)) {
    console.log(`Valid email detected in DM: ${userEmail}`);

    // Verify if the email exists in the User collection
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      console.log(`No user found with email ${userEmail}`);
      await message.channel.send(
        "No subscription found with this email. Please ensure you provide the email used for your subscription (e.g., deepgondaliya773@gmail.com)."
      );
      return;
    }

    // Verify if the email has a corresponding InviteLink
    const inviteLink = await InviteLink.findOne({ email: userEmail });
    if (!inviteLink) {
      console.log(`No invite link found for email ${userEmail}`);
      await message.channel.send(
        "No invite links found for this email. Please ensure you completed the subscription process or contact support."
      );
      return;
    }
    console.log(
      `InviteLink found for ${userEmail}: ${JSON.stringify(inviteLink)}`
    );

    // Verify Discord link (log for debugging, but proceed if email matches)
    const expectedDiscordLink = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_BOT_ID}&scope=bot&permissions=2048`;
    if (inviteLink.invite_links.discord !== expectedDiscordLink) {
      console.warn(
        `Discord link mismatch for ${userEmail}. Expected: ${expectedDiscordLink}, Found: ${inviteLink.invite_links.discord}`
      );
    }

    // Store the discord_user_id
    try {
      const updatedUser = await User.findOneAndUpdate(
        { email: userEmail },
        { $set: { discord_user_id: userDiscordId } },
        { new: true }
      );
      console.log(
        `Stored Discord user ID ${userDiscordId} for email ${userEmail}. Updated user: ${JSON.stringify(
          updatedUser
        )}`
      );
      await message.channel.send(
        "Thank you! Your Discord ID has been linked to your subscription. You'll now receive broadcast messages here."
      );
    } catch (error) {
      console.error(
        `Error storing Discord user ID for ${userEmail}: ${error.message}`,
        error.stack
      );
      await message.channel.send(
        "An error occurred while linking your Discord ID. Please try again or contact support."
      );
    }
  } else {
    console.log(
      `No valid email detected in message from ${userDiscordId}: ${userMessage}`
    );
    await message.channel.send(
      "Please send the email address you used for your subscription to link your Discord account (e.g., deepgondaliya773@gmail.com)."
    );
  }
});

discordClient.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  console.error("Failed to login to Discord:", err.message);
});

// Apply CORS globally
app.use(cors());

// Apply raw body parsing specifically for Stripe webhook
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("Webhook endpoint hit: data enter+++++++");

    const sig = req.headers["stripe-signature"];
    const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripeClient.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
      console.log("Webhook event verified:", event.type);
    } catch (error) {
      console.error("Webhook signature verification failed:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    // Only handle checkout.session.completed event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { email, phone_number, whatsapp_number } = session.metadata;
      console.log("Processing checkout.session.completed for email:", email);

      if (!email || !whatsapp_number) {
        console.error(
          "Missing metadata in checkout.session.completed:",
          session.metadata
        );
        return res
          .status(400)
          .send("Webhook Error: Missing email or whatsapp_number in metadata");
      }

      // Store payment in MongoDB
      try {
        const payment = new Payment({
          email,
          stripe_payment_id: session.payment_intent,
          amount: session.amount_total,
          currency: session.currency,
          status: session.payment_status,
          phone_number,
          whatsapp_number,
        });
        await payment.save();
        console.log(`Stored payment for email ${email}`);
      } catch (paymentError) {
        console.error(
          "Error saving payment to MongoDB:",
          paymentError.message,
          paymentError.stack
        );
        return res.status(500).send(`Webhook Error: ${paymentError.message}`);
      }

      // Create or update user subscription
      try {
        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + 30);

        await User.findOneAndUpdate(
          { email },
          { email, channel_id: TELEGRAM_GROUP_ID, expire_date: expireDate },
          { upsert: true }
        );
        console.log(`Updated subscription for email ${email}`);
      } catch (userError) {
        console.error(
          "Error updating user subscription in MongoDB:",
          userError.message,
          userError.stack
        );
        return res.status(500).send(`Webhook Error: ${userError.message}`);
      }

      // Generate Telegram and Discord invite links
      let inviteLinkData = { telegram: "", whatsapp: "", discord: "" };
      try {
        // Generate Telegram invite link
        try {
          const telegramResponse = await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
            {
              chat_id: TELEGRAM_GROUP_ID,
              creates_join_request: false,
              member_limit: 1,
            }
          );
          inviteLinkData.telegram = telegramResponse.data.result.invite_link;
          console.log(
            `Generated Telegram invite link for email ${email}: ${inviteLinkData.telegram}`
          );
        } catch (telegramError) {
          console.error(
            "Error generating Telegram invite link:",
            telegramError.response
              ? telegramError.response.data
              : telegramError.message,
            telegramError.stack
          );
          throw new Error(
            `Failed to generate Telegram invite link: ${telegramError.message}`
          );
        }

        // Use bot invite link
        inviteLinkData.discord = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_BOT_ID}&scope=bot&permissions=2048`;
        console.log(
          `Generated Discord bot invite link for email ${email}: ${inviteLinkData.discord}`
        );

        // Store the invite links in MongoDB
        try {
          await InviteLink.findOneAndUpdate(
            { email },
            {
              email,
              invite_links: inviteLinkData,
              created_at: new Date(),
            },
            { upsert: true }
          );
          console.log(`Stored invite links for email ${email}`);
        } catch (inviteLinkError) {
          console.error(
            "Error storing invite links in MongoDB:",
            inviteLinkError.message,
            inviteLinkError.stack
          );
          throw new Error(
            `Failed to store invite links: ${inviteLinkError.message}`
          );
        }

        // Send WhatsApp message with Telegram and Discord bot invite links
        try {
          const messageText = `Thank you for your payment! Join our Telegram channel here: ${inviteLinkData.telegram}\nAdd our Discord bot to a server here: ${inviteLinkData.discord}\nAfter adding the bot, send your subscription email (e.g., ${email}) via DM to link your account for broadcast messages.`;
          const recipientNumber = whatsapp_number.replace(/\D/g, "");
          const formData = new FormData();
          formData.append("phonenumber", recipientNumber);
          formData.append("text", messageText);

          await axios.post(
            "https://api.360messenger.com/v2/sendMessage",
            formData,
            {
              headers: {
                Authorization: `Bearer ${process.env.MESSENGER_API_KEY}`,
                ...formData.getHeaders(),
              },
            }
          );
          console.log(
            `Sent WhatsApp message to ${whatsapp_number} for email ${email}`
          );
        } catch (whatsAppError) {
          console.error(
            "Error sending WhatsApp message via 360Messenger:",
            whatsAppError.response
              ? whatsAppError.response.data
              : whatsAppError.message,
            whatsAppError.stack
          );
          throw new Error(
            `Failed to send WhatsApp message: ${whatsAppError.message}`
          );
        }
      } catch (inviteError) {
        console.error(
          "Error in invite link generation or WhatsApp sending:",
          inviteError.message,
          inviteError.stack
        );
        return res.status(500).send(`Webhook Error: ${inviteError.message}`);
      }
    } else {
      console.log(`Ignoring event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Apply JSON parsing for all other routes
app.use(express.json());

// Modified broadcast endpoint to handle text and file
app.post("/api/broadcast-message", upload.single("file"), async (req, res) => {
  const { message } = req.body;
  const file = req.file;

  if (!message && !file) {
    return res.status(400).json({ error: "Message or file is required" });
  }

  let telegramSuccess = false;
  let discordSuccess = false;
  let whatsappSuccess = false;
  let errorMessage = "";
  let blobUrl = null;

  // Helper function to clean up uploaded file
  const cleanupFile = (filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error(`Error deleting file ${filePath}:`, err);
      });
    }
  };

  // Upload file to Vercel Blob for WhatsApp
  if (file) {
    try {
      const blob = await put(file.filename, fs.createReadStream(file.path), {
        access: "public",
        token: process.env.VERCEL_BLOB_TOKEN,
      });
      blobUrl = blob.url;
      console.log(`Uploaded file to Vercel Blob: ${blobUrl}`);
    } catch (blobError) {
      console.error(
        "Error uploading to Vercel Blob:",
        blobError.message,
        blobError.stack
      );
      errorMessage += `Vercel Blob upload error: ${blobError.message}; `;
    }
  }

  // Send to Telegram
  try {
    if (file) {
      const filePath = file.path;
      const fileType = file.mimetype;
      let telegramMethod;

      if (fileType.startsWith("image/")) {
        telegramMethod = "sendPhoto";
      } else if (fileType.startsWith("video/")) {
        telegramMethod = "sendVideo";
      } else {
        telegramMethod = "sendDocument";
      }

      const formData = new FormData();
      formData.append("chat_id", TELEGRAM_GROUP_ID);
      formData.append(
        telegramMethod === "sendPhoto"
          ? "photo"
          : telegramMethod === "sendVideo"
          ? "video"
          : "document",
        fs.createReadStream(filePath)
      );
      if (message) {
        formData.append("caption", message);
      }

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${telegramMethod}`,
        formData,
        {
          headers: formData.getHeaders(),
        }
      );
      console.log(`Broadcast ${telegramMethod} to Telegram successfully`);
    } else {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_GROUP_ID,
          text: message,
        }
      );
      console.log("Broadcast text to Telegram successfully");
    }
    telegramSuccess = true;
  } catch (telegramError) {
    errorMessage += `Telegram error: ${
      telegramError.response
        ? telegramError.response.data
        : telegramError.message
    }; `;
    console.error(
      "Error broadcasting to Telegram:",
      telegramError.response
        ? telegramError.response.data
        : telegramError.message,
      telegramError.stack
    );
  }

  // Send to Discord
  if (isDiscordReady) {
    try {
      const activeUsers = await User.find({
        expire_date: { $gt: new Date() },
        discord_user_id: { $exists: true, $ne: null },
      });

      if (activeUsers.length === 0) {
        console.log("No active Discord users found for broadcast");
      } else {
        for (const user of activeUsers) {
          try {
            const discordUser = await discordClient.users.fetch(
              user.discord_user_id
            );
            if (file) {
              await discordUser.send({
                content: message || "",
                files: [
                  {
                    attachment: file.path,
                    name: file.originalname,
                  },
                ],
              });
              console.log(
                `Broadcast file to Discord user ${user.discord_user_id} for email ${user.email}`
              );
            } else {
              await discordUser.send(message);
              console.log(
                `Broadcast text to Discord user ${user.discord_user_id} for email ${user.email}`
              );
            }
          } catch (dmError) {
            console.error(
              `Error sending to Discord user ${user.discord_user_id}:`,
              dmError.message,
              dmError.stack
            );
          }
        }
        discordSuccess = true;
        console.log("Broadcast to Discord DMs successfully");
      }
    } catch (discordError) {
      errorMessage += `Discord error: ${discordError.message}; `;
      console.error(
        "Error broadcasting to Discord DMs:",
        discordError.message,
        discordError.stack
      );
    }
  } else {
    errorMessage += "Discord client is not ready; ";
    console.warn("Discord client not ready, skipping Discord broadcast");
  }

  // Send to WhatsApp
  try {
    const activeUsers = await User.find({
      expire_date: { $gt: new Date() },
    });
    const emails = activeUsers.map((user) => user.email);
    const payments = await Payment.find({ email: { $in: emails } });

    if (payments.length === 0) {
      console.log("No active users with WhatsApp numbers found for broadcast");
    } else {
      for (const payment of payments) {
        const recipientNumber = payment.whatsapp_number.replace(/\D/g, "");
        const formData = new FormData();
        formData.append("phonenumber", recipientNumber);
        formData.append("text", message || "Attachment");

        if (file && blobUrl) {
          formData.append("url", blobUrl);
        } else if (file && !blobUrl) {
          console.log(
            `Skipping WhatsApp broadcast for ${recipientNumber} due to Vercel Blob upload failure`
          );
          continue;
        }

        try {
          const response = await axios.post(
            "https://api.360messenger.com/v2/sendMessage",
            formData,
            {
              headers: {
                Authorization: `Bearer ${process.env.MESSENGER_API_KEY}`,
                ...formData.getHeaders(),
              },
            }
          );
          console.log(
            `Broadcast to WhatsApp number ${recipientNumber} for email ${
              payment.email
            }: ${JSON.stringify(response.data)}`
          );
        } catch (whatsAppError) {
          console.error(
            `Error sending WhatsApp broadcast to ${recipientNumber}:`,
            whatsAppError.response
              ? whatsAppError.response.data
              : whatsAppError.message,
            whatsAppError.stack
          );
          errorMessage += `WhatsApp error for ${recipientNumber}: ${
            whatsAppError.response
              ? whatsAppError.response.data
              : whatsAppError.message
          }; `;
          continue;
        }
      }
      whatsappSuccess = payments.length > 0;
      console.log("Broadcast to WhatsApp users successfully");
    }
  } catch (whatsAppError) {
    errorMessage += `WhatsApp error: ${
      whatsAppError.response
        ? whatsAppError.response.data
        : whatsAppError.message
    }; `;
    console.error(
      "Error broadcasting to WhatsApp users:",
      whatsAppError.message,
      whatsAppError.stack
    );
  }

  // Clean up uploaded file and Vercel Blob
  if (file) {
    cleanupFile(file.path);
    if (blobUrl) {
      try {
        await del(blobUrl, { token: process.env.VERCEL_BLOB_TOKEN });
        console.log(`Deleted file from Vercel Blob: ${blobUrl}`);
      } catch (delError) {
        console.error(
          `Error deleting from Vercel Blob: ${delError.message}`,
          delError.stack
        );
      }
    }
  }

  if (telegramSuccess || discordSuccess || whatsappSuccess) {
    let successMessage = "Broadcast successful to: ";
    const platforms = [];
    if (telegramSuccess) platforms.push("Telegram");
    if (discordSuccess) platforms.push("Discord DMs");
    if (whatsappSuccess) platforms.push("WhatsApp");
    successMessage += platforms.join(", ").replace(/, ([^,]*)$/, " and $1");
    res.json({ success: true, message: successMessage });
  } else {
    res.status(500).json({ error: `Failed to broadcast: ${errorMessage}` });
  }
});

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DISCORD_BOT_ID = process.env.DISCORD_BOT_ID;

const stripeClient = stripe(STRIPE_SECRET_KEY);

// MongoDB User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  channel_id: { type: String, required: true },
  expire_date: { type: Date, required: true },
  discord_user_id: { type: String },
});

const User = mongoose.model("User", userSchema);

// MongoDB Payment Schema
const paymentSchema = new mongoose.Schema({
  email: { type: String, required: true },
  stripe_payment_id: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  status: { type: String, required: true },
  phone_number: { type: String },
  whatsapp_number: { type: String },
  created_at: { type: Date, default: Date.now },
});

const Payment = mongoose.model("Payment", paymentSchema);

// MongoDB InviteLink Schema
const inviteLinkSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  invite_links: {
    telegram: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    discord: { type: String, default: "" },
  },
  created_at: { type: Date, default: Date.now },
});

const InviteLink = mongoose.model("InviteLink", inviteLinkSchema);

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// API to create Stripe Checkout Session
app.post("/api/create-checkout-session", async (req, res) => {
  console.log("data $$$$$$$$$$");
  const { email, phone_number, whatsapp_number } = req.body;

  if (!email || !whatsapp_number) {
    return res
      .status(400)
      .json({ error: "email and whatsapp_number are required" });
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Telegram Channel Subscription",
            },
            unit_amount: 6000,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url:
        "https://automated-membership-management.vercel.app/success?session_id={CHECKOUT_SESSION_ID}&email=" +
        encodeURIComponent(email),
      cancel_url: "https://automated-membership-management.vercel.app/cancel",
      metadata: {
        email,
        phone_number: phone_number || "",
        whatsapp_number,
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(
      "Error creating checkout session:",
      error.message,
      error.code ? `Code: ${error.code}` : "",
      error.raw ? `Raw: ${JSON.stringify(error.raw)}` : ""
    );
    res
      .status(500)
      .json({ error: `Failed to create checkout session: ${error.message}` });
  }
});

// API to generate Telegram invite link (for manual generation)
app.post("/api/generate-invite", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  try {
    // Check if user has an active subscription
    const user = await User.findOne({ email });
    if (!user || user.expire_date < new Date()) {
      return res.status(403).json({ error: "No active subscription" });
    }

    // Generate Telegram invite link
    const telegramResponse = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
      {
        chat_id: TELEGRAM_GROUP_ID,
        creates_join_request: false,
        member_limit: 1,
      }
    );
    const telegramInviteLink = telegramResponse.data.result.invite_link;

    // Use bot invite link
    const discordInviteLink = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_BOT_ID}&scope=bot&permissions=2048`;

    // Update the invite links in MongoDB
    await InviteLink.findOneAndUpdate(
      { email },
      {
        $set: {
          "invite_links.telegram": telegramInviteLink,
          "invite_links.discord": discordInviteLink,
          created_at: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({
      telegram_invite_link: telegramInviteLink,
      discord_invite_link: discordInviteLink,
    });
  } catch (error) {
    console.error(
      "Error generating invite links:",
      error.response ? error.response.data : error.message,
      error.stack
    );
    res.status(500).json({ error: "Failed to generate invite links" });
  }
});

// API to retrieve invite links
app.get("/api/get-invite-link", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  try {
    const inviteLink = await InviteLink.findOne({ email });
    if (
      !inviteLink ||
      (!inviteLink.invite_links.telegram && !inviteLink.invite_links.discord)
    ) {
      return res.status(404).json({ error: "Invite links not found" });
    }

    res.json({
      telegram_invite_link: inviteLink.invite_links.telegram,
      discord_invite_link: inviteLink.invite_links.discord,
    });
  } catch (error) {
    console.error("Error retrieving invite links:", error.message, error.stack);
    res.status(500).json({ error: "Failed to retrieve invite links" });
  }
});

cron.schedule("*/1 * * * *", async () => {
  console.log("Checking for expired subscriptions...");
  try {
    const currentDate = new Date();
    const expiredUsers = await User.find({
      expire_date: { $lt: currentDate },
    });

    for (const user of expiredUsers) {
      try {
        console.log(`Subscription expired for email ${user.email}`);
        await User.deleteOne({ _id: user._id });
        console.log(`Deleted user with email ${user.email} from database`);
        await InviteLink.deleteOne({ email: user.email });
        console.log(`Deleted invite link for email ${user.email}`);
      } catch (error) {
        console.error(
          `Error processing email ${user.email}:`,
          error.response ? error.response.data : error.message,
          error.stack
        );
      }
    }
  } catch (error) {
    console.error("Error in cron job:", error.message, error.stack);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
