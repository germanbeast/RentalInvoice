const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// API: Generate PDF
app.post('/api/generate-pdf', async (req, res) => {
    try {
        const { html } = req.body;
        if (!html) return res.status(400).send('HTML content is required');

        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Use a wrapper to ensure styles are loaded or passed
        await page.setContent(html, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true
        });

        await browser.close();

        res.contentType('application/pdf');
        res.send(pdf);
    } catch (error) {
        console.error('PDF Generation Error:', error);
        res.status(500).send('Failed to generate PDF');
    }
});

// API: Send Email
app.post('/api/send-email', async (req, res) => {
    try {
        const { to, subject, body, pdfBuffer, fileName, smtpConfig } = req.body;

        if (!smtpConfig || !smtpConfig.host) {
            return res.status(400).send('SMTP configuration is missing');
        }

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: smtpConfig.port || 587,
            secure: smtpConfig.secure || false,
            auth: {
                user: smtpConfig.user,
                pass: smtpConfig.pass
            }
        });

        const mailOptions = {
            from: smtpConfig.from || smtpConfig.user,
            to,
            subject,
            text: body,
            attachments: [
                {
                    filename: fileName || 'Rechnung.pdf',
                    content: Buffer.from(pdfBuffer, 'base64')
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        res.send({ success: true, message: 'Email sent successfully' });
    } catch (error) {
        console.error('Email Sending Error:', error);
        res.status(500).send('Failed to send email: ' + error.message);
    }
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
