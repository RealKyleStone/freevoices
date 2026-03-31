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
          name: process.env.SMTP_FROM_NAME || 'Freevoices',
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
  async sendInvoiceEmail(toEmail, invoice, pdfBuffer) {
    const subject = `Invoice ${invoice.document_number} from ${invoice.company_name}`;

    const mailOptions = {
      from: {
        name: invoice.company_name || process.env.SMTP_FROM_NAME || 'Freevoices',
        address: process.env.SMTP_FROM_ADDRESS || this.transporter.options.auth.user
      },
      to: toEmail,
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0;">
            <h1 style="color: #ffffff; margin: 0; font-size: 20px;">${invoice.company_name || 'Invoice'}</h1>
          </div>
          <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb;">
            <p style="color: #374151;">Hi ${invoice.customer_name},</p>
            <p style="color: #374151;">
              Please find attached invoice <strong>${invoice.document_number}</strong>
              ${invoice.due_date ? `due on <strong>${new Date(invoice.due_date).toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' })}</strong>` : ''}.
            </p>
            <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
              <tr style="background: #e5e7eb;">
                <td style="padding: 8px 12px; font-weight: bold; color: #374151;">Invoice #</td>
                <td style="padding: 8px 12px; color: #374151;">${invoice.document_number}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; font-weight: bold; color: #374151;">Amount Due</td>
                <td style="padding: 8px 12px; color: #374151; font-size: 18px; font-weight: bold;">R ${parseFloat(invoice.total).toFixed(2)}</td>
              </tr>
              ${invoice.due_date ? `
              <tr style="background: #e5e7eb;">
                <td style="padding: 8px 12px; font-weight: bold; color: #374151;">Due Date</td>
                <td style="padding: 8px 12px; color: #374151;">${new Date(invoice.due_date).toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' })}</td>
              </tr>` : ''}
            </table>
            ${invoice.bank_name ? `
            <div style="background: #eff6ff; border-left: 4px solid #4a90e2; padding: 12px 16px; margin: 16px 0; border-radius: 0 4px 4px 0;">
              <p style="margin: 0 0 4px; font-weight: bold; color: #1e40af;">Banking Details</p>
              <p style="margin: 0; color: #374151; font-size: 14px;">
                ${invoice.bank_name}${invoice.bank_account_number ? ` &nbsp;·&nbsp; Account: ${invoice.bank_account_number}` : ''}${invoice.bank_branch_code ? ` &nbsp;·&nbsp; Branch: ${invoice.bank_branch_code}` : ''}
              </p>
            </div>` : ''}
            <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
              If you have any questions please reply to this email.
            </p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: `${invoice.document_number}.pdf`,
          content:  pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    };

    return this.transporter.sendMail(mailOptions);
  }

  async sendPasswordResetEmail(email, token) {
    const resetUrl = `${process.env.APP_URL}/auth/reset-password?token=${token}`;

    const mailOptions = {
      from: {
        name: process.env.SMTP_FROM_NAME || 'Freevoices',
        address: process.env.SMTP_FROM_ADDRESS || this.transporter.options.auth.user
      },
      to: email,
      subject: 'Reset Your Password',
      html: `
        <h1>Password Reset</h1>
        <p>You requested a password reset for your Freevoices account.</p>
        <p>Click the link below to set a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}">${resetUrl}</a>
        <p>If you did not request this, you can safely ignore this email.</p>
      `
    };

    return this.transporter.sendMail(mailOptions);
  }
}

module.exports = EmailService;