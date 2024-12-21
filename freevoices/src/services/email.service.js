// server/services/email.service.js
const nodemailer = require('nodemailer');

class EmailService {
  constructor(config) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
      }
    });
    
    this.fromEmail = config.SMTP_FROM;
    this.appUrl = config.APP_URL;
  }

  async sendVerificationEmail(email, token) {
    try {
      console.log('Attempting to send email with config:', {
        host: this.transporter.options.host,
        port: this.transporter.options.port,
        secure: this.transporter.options.secure,
        user: this.transporter.options.auth.user
      });
  
      const result = await this.transporter.sendMail({
        from: this.fromEmail,
        to: email,
        subject: 'Verify Your Email',
        html: `
          <h1>Welcome!</h1>
          <p>Please verify your email by clicking the link below:</p>
          <a href="${this.appUrl}/verify-email?token=${token}">Verify Email</a>
          <p>This link will expire in 24 hours.</p>
        `
      });
      
      console.log('Email sent:', result);
      return true;
    } catch (error) {
      console.error('Detailed email error:', {
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
        errorCode: error.code,
        responseCode: error.responseCode
      });
      throw error;
    }
  }
}

module.exports = EmailService;