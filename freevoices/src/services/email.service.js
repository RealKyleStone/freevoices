const nodemailer = require('nodemailer');

class EmailService {
  constructor(config) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: false, // Force this to false to use STARTTLS
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
      },
      tls: {
        rejectUnauthorized: false, // For testing - enable in production
        minVersion: 'TLSv1.2',
        ciphers: 'HIGH:MEDIUM:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5'
      },
      debug: true,
      logger: true
    });

    // Test connection on initialization
    this.testConnection();
  }

  async testConnection() {
    try {
      const verification = await this.transporter.verify();
      console.log('SMTP Connection verified:', verification);
      return true;
    } catch (error) {
      console.error('SMTP Connection test failed:', {
        code: error.code,
        command: error.command,
        response: error.response,
        stack: error.stack
      });
      return false;
    }
  }

  async sendVerificationEmail(email, token) {
    try {
      // Force connection verification before sending
      await this.testConnection();
      
      const verificationUrl = `${process.env.APP_URL}/verify-email?token=${token}`;
      
      const mailOptions = {
        from: {
          name: process.env.SMTP_FROM_NAME || 'Your Application',
          address: process.env.SMTP_FROM_ADDRESS || this.transporter.options.auth.user
        },
        to: email,
        subject: 'Verify Your Email Address',
        html: `
          <h1>Email Verification</h1>
          <p>Please click the link below to verify your email address:</p>
          <a href="${verificationUrl}">${verificationUrl}</a>
          <p>This link will expire in 24 hours.</p>
        `
      };

      console.log('Attempting to send email with options:', {
        host: this.transporter.options.host,
        port: this.transporter.options.port,
        secure: this.transporter.options.secure
      });

      const result = await this.transporter.sendMail(mailOptions);
      console.log('Email sent successfully:', {
        messageId: result.messageId,
        response: result.response
      });
      return result;
    } catch (error) {
      console.error('Detailed email error:', {
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode,
        stack: error.stack
      });
      throw error;
    }
  }
}

module.exports = EmailService;