import React, { useState, useEffect } from "react";
import axios from "axios";
import "./App.css";

function App() {
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [whatsAppNumber, setWhatsAppNumber] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState(null);
  const [inviteLink, setInviteLink] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const handlePayment = async (e) => {
    e.preventDefault();
    setError("");
    setStatus("");

    // Validate WhatsApp number format (e.g., +1234567890)
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(whatsAppNumber)) {
      setError(
        "Please enter a valid WhatsApp number in international format (e.g., +1234567890)"
      );
      return;
    }

    try {
      const response = await axios.post(
        "http://localhost:5000/api/create-checkout-session",
        {
          email,
          phone_number: phoneNumber,
          whatsapp_number: whatsAppNumber,
        }
      );
      window.location.href = response.data.url;
    } catch (err) {
      setError(
        "Failed to initiate payment: " +
          (err.response?.data?.error || err.message)
      );
    }
  };

  const handleGenerateLink = async (e) => {
    e.preventDefault();
    setError("");
    setStatus("");
    setInviteLink("");

    try {
      const response = await axios.post(
        "http://localhost:5000/api/generate-invite",
        {
          email,
        }
      );
      setInviteLink(response.data.telegram_invite_link);
      setStatus(
        "Invite links generated successfully! Telegram: " +
          response.data.telegram_invite_link +
          " | Discord Bot: " +
          response.data.discord_invite_link +
          " (Add the bot and send '/start " +
          email +
          "')"
      );
    } catch (err) {
      setError("Error: " + (err.response?.data?.error || err.message));
    }
  };

  const handleBroadcast = async (e) => {
    e.preventDefault();
    setError("");
    setStatus("");

    if (!message && !file) {
      setError("Please provide a message or file to broadcast");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("message", message);
      if (file) {
        formData.append("file", file);
      }

      const response = await axios.post(
        "http://localhost:5000/api/broadcast-message",
        formData,
        {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        }
      );
      setStatus(response.data.message);
      setMessage("");
      setFile(null);
      document.getElementById("fileInput").value = null; // Reset file input
    } catch (err) {
      setError("Error: " + (err.response?.data?.error || err.message));
    }
  };

  // Check for success/cancel redirect and retrieve invite link
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const success = query.get("success");
    const emailFromUrl = query.get("email");

    if (success && emailFromUrl) {
      setStatus("Payment successful! Retrieving your invite link...");
      setEmail(emailFromUrl);

      const retrieveInviteLink = async () => {
        try {
          const response = await axios.get(
            "http://localhost:5000/api/get-invite-link",
            {
              params: { email: emailFromUrl },
            }
          );
          setInviteLink(response.data.telegram_invite_link);
          setStatus(
            "Payment successful! Here are your invite links (also sent via WhatsApp): Telegram: " +
              response.data.telegram_invite_link +
              " | Discord Bot: " +
              response.data.discord_invite_link +
              " (Add the bot and send '/start " +
              emailFromUrl +
              "')"
          );
        } catch (err) {
          setError(
            "Error retrieving invite link: " +
              (err.response?.data?.error || err.message)
          );
        }
      };

      retrieveInviteLink();
    } else if (query.get("canceled")) {
      setError("Payment canceled. Please try again.");
    }
  }, []);

  return (
    <div className="App">
      <h1>Automated Membership Management</h1>

      <div className="section">
        <h2>Make a Payment</h2>
        <form onSubmit={handlePayment}>
          <input
            type="email"
            placeholder="Email (e.g., test@example.com)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="tel"
            placeholder="Phone Number (e.g., +1234567890)"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
          />
          <input
            type="tel"
            placeholder="WhatsApp Number (e.g., +1234567890)"
            value={whatsAppNumber}
            onChange={(e) => setWhatsAppNumber(e.target.value)}
            required
          />
          <button type="submit">Pay with Stripe</button>
        </form>
      </div>

      <div className="section">
        <h2>Generate Invite Link (Manual)</h2>
        <form onSubmit={handleGenerateLink}>
          <input
            type="email"
            placeholder="Email (e.g., test@example.com)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit">Generate Link</button>
        </form>
      </div>

      <div className="section">
        <h2>Broadcast Message</h2>
        <form onSubmit={handleBroadcast}>
          <textarea
            placeholder="Enter message to broadcast"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <input
            type="file"
            id="fileInput"
            accept="image/jpeg,image/png,video/mp4,application/pdf,.doc,.docx"
            onChange={(e) => setFile(e.target.files[0])}
          />
          <button type="submit">Broadcast</button>
        </form>
      </div>

      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
      {inviteLink && (
        <div>
          <p>
            Your Telegram Invite Link: <a href={inviteLink}>{inviteLink}</a>
          </p>
        </div>
      )}
    </div>
  );
}

export default App;
