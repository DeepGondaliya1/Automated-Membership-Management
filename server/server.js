const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const cron = require("node-cron");
const stripe = require("stripe");
const { Client, GatewayIntentBits } = require("discord.js");

dotenv.config();

const app = express();

// Initialize Discord client
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

// Wait for Discord client to be ready
let isDiscordReady = false;
discordClient.once("ready", () => {
  console.log(`Logged in to Discord as ${discordClient.user.tag}`);
  isDiscordReady = true;
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
        console.error("Error saving payment to MongoDB:", paymentError.message);
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
          userError.message
        );
        return res.status(500).send(`Webhook Error: ${userError.message}`);
      }

      // Generate Telegram and Discord invite links
      let inviteLinkData = { telegram: "", whatsapp: "", discord: "" };
      try {
        // Generate Telegram invite link
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

        // Generate Discord invite link
        if (!isDiscordReady) {
          throw new Error("Discord client is not ready yet");
        }
        let guild;
        try {
          guild = await discordClient.guilds.fetch(DISCORD_SERVER_ID);
        } catch (guildError) {
          console.error("Failed to fetch Discord guild:", guildError.message);
          throw new Error(
            `Failed to fetch Discord guild: ${guildError.message}`
          );
        }

        const channel = guild.channels.cache.find(
          (ch) => ch.type === 0 // 0 is for text channels in Discord.js v14
        ); // Get the first text channel
        if (!channel) {
          throw new Error("No text channel found in the Discord server");
        }

        let discordInvite;
        try {
          discordInvite = await channel.createInvite({
            maxUses: 1,
            unique: true,
            reason: `Invite for email ${email}`,
          });
        } catch (inviteError) {
          console.error(
            "Failed to create Discord invite:",
            inviteError.message
          );
          throw new Error(
            `Failed to create Discord invite: ${inviteError.message}`
          );
        }

        inviteLinkData.discord = `https://discord.gg/${discordInvite.code}`;
        console.log(
          `Generated Discord invite link for email ${email}: ${inviteLinkData.discord}`
        );

        // Store the invite links in MongoDB
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

        // Send WhatsApp message with both Telegram and Discord invite links using 360Messenger
        try {
          const messageText = `Thank you for your payment! Join our Telegram channel here: ${inviteLinkData.telegram}\nJoin our Discord server here: ${inviteLinkData.discord}`;
          const recipientNumber = whatsapp_number.replace(/\D/g, ""); // Remove non-digits

          const formData = new URLSearchParams();
          formData.append("phonenumber", recipientNumber);
          formData.append("text", messageText);

          await axios.post(
            "https://api.360messenger.com/v2/sendMessage",
            formData,
            {
              headers: {
                Authorization: `Bearer ${process.env.MESSENGER_API_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
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
              : whatsAppError.message
          );
          return res
            .status(500)
            .send(`Webhook Error: ${whatsAppError.message}`);
        }
      } catch (inviteError) {
        console.error(
          "Error generating/storing invite links:",
          inviteError.message
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

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const DISCORD_SERVER_ID = process.env.DISCORD_SERVER_ID;

const stripeClient = stripe(STRIPE_SECRET_KEY);

// MongoDB User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  channel_id: { type: String, required: true },
  expire_date: { type: Date, required: true },
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
            unit_amount: 6000, // $50.00
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

    // Generate Discord invite link
    if (!isDiscordReady) {
      return res.status(500).json({ error: "Discord client is not ready yet" });
    }
    let guild;
    try {
      guild = await discordClient.guilds.fetch(DISCORD_SERVER_ID);
    } catch (guildError) {
      console.error("Failed to fetch Discord guild:", guildError.message);
      return res.status(500).json({
        error: `Failed to fetch Discord guild: ${guildError.message}`,
      });
    }

    const channel = guild.channels.cache.find((ch) => ch.type === 0); // First text channel
    if (!channel) {
      return res
        .status(500)
        .json({ error: "No text channel found in the Discord server" });
    }

    let discordInvite;
    try {
      discordInvite = await channel.createInvite({
        maxUses: 1,
        unique: true,
        reason: `Invite for email ${email}`,
      });
    } catch (inviteError) {
      console.error("Failed to create Discord invite:", inviteError.message);
      return res.status(500).json({
        error: `Failed to create Discord invite: ${inviteError.message}`,
      });
    }

    const discordInviteLink = `https://discord.gg/${discordInvite.code}`;

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
      error.response ? error.response.data : error.message
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
    console.error("Error retrieving invite links:", error.message);
    res.status(500).json({ error: "Failed to retrieve invite links" });
  }
});

// API to broadcast message to Telegram channel, Discord server, and WhatsApp users
app.post("/api/broadcast-message", async (req, res) => {
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  let telegramSuccess = false;
  let discordSuccess = false;
  let whatsappSuccess = false;
  let errorMessage = "";

  // Send message to Telegram channel
  try {
    const telegramResponse = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_GROUP_ID,
        text: message,
      }
    );
    telegramSuccess = true;
    console.log("Message broadcasted to Telegram successfully");
  } catch (telegramError) {
    errorMessage += `Telegram error: ${
      telegramError.response
        ? telegramError.response.data
        : telegramError.message
    }; `;
    console.error(
      "Error broadcasting message to Telegram:",
      telegramError.response
        ? telegramError.response.data
        : telegramError.message
    );
  }

  // Send message to Discord server
  if (isDiscordReady) {
    try {
      const guild = await discordClient.guilds.fetch(DISCORD_SERVER_ID);
      const channel = guild.channels.cache.find((ch) => ch.type === 0); // First text channel
      if (!channel) {
        throw new Error("No text channel found in the Discord server");
      }
      await channel.send(message);
      discordSuccess = true;
      console.log("Message broadcasted to Discord successfully");
    } catch (discordError) {
      errorMessage += `Discord error: ${discordError.message}; `;
      console.error(
        "Error broadcasting message to Discord:",
        discordError.message
      );
    }
  } else {
    errorMessage += "Discord client is not ready; ";
    console.warn("Discord client not ready, skipping Discord broadcast");
  }

  // Send message to WhatsApp users
  try {
    // Retrieve WhatsApp numbers of users with active subscriptions
    const activeUsers = await User.find({
      expire_date: { $gt: new Date() },
    });
    const emails = activeUsers.map((user) => user.email);
    const payments = await Payment.find({ email: { $in: emails } });

    if (payments.length === 0) {
      console.log("No active users with WhatsApp numbers found for broadcast");
    } else {
      for (const payment of payments) {
        const recipientNumber = payment.whatsapp_number.replace(/\D/g, ""); // Remove non-digits
        const formData = new URLSearchParams();
        formData.append("phonenumber", recipientNumber);
        formData.append("text", message);

        try {
          await axios.post(
            "https://api.360messenger.com/v2/sendMessage",
            formData,
            {
              headers: {
                Authorization: `Bearer ${process.env.MESSENGER_API_KEY}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
            }
          );
          console.log(
            `Broadcast message sent to WhatsApp number ${recipientNumber} for email ${payment.email}`
          );
        } catch (whatsAppError) {
          console.error(
            `Error sending WhatsApp broadcast to ${recipientNumber}:`,
            whatsAppError.response
              ? whatsAppError.response.data
              : whatsAppError.message
          );
          // Continue with other numbers even if one fails
        }
      }
      whatsappSuccess = true;
      console.log("Message broadcasted to WhatsApp users successfully");
    }
  } catch (whatsAppError) {
    errorMessage += `WhatsApp error: ${
      whatsAppError.response
        ? whatsAppError.response.data
        : whatsAppError.message
    }; `;
    console.error(
      "Error broadcasting message to WhatsApp users:",
      whatsAppError.message
    );
  }

  if (telegramSuccess || discordSuccess || whatsappSuccess) {
    let successMessage = "Message broadcasted successfully to: ";
    const platforms = [];
    if (telegramSuccess) platforms.push("Telegram");
    if (discordSuccess) platforms.push("Discord");
    if (whatsappSuccess) platforms.push("WhatsApp");
    successMessage += platforms.join(", ").replace(/, ([^,]*)$/, " and $1");
    res.json({ success: true, message: successMessage });
  } else {
    res
      .status(500)
      .json({ error: `Failed to broadcast message: ${errorMessage}` });
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
        // Since we don't have user_id, we can't remove users from Telegram or Discord
        // Optionally, you can log the expiry for manual removal
        console.log(`Subscription expired for email ${user.email}`);

        await User.deleteOne({ _id: user._id });
        console.log(`Deleted user with email ${user.email} from database`);

        // Remove invite link for expired user
        await InviteLink.deleteOne({ email: user.email });
        console.log(`Deleted invite link for email ${user.email}`);
      } catch (error) {
        console.error(
          `Error processing email ${user.email}:`,
          error.response ? error.response.data : error.message
        );
      }
    }
  } catch (error) {
    console.error("Error in cron job:", error.message);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
