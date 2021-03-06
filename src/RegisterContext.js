"use strict";
module.exports = function (SIP) {

var RegisterContext;

RegisterContext = function (ua, options = {}) {
  this.options = options;
  this.options.extraContactHeaderParams = this.options.extraContactHeaderParams || [];
  this.options.instanceId = this.options.instanceId || ua.configuration.instanceId; // TODO: No way to turn off instance-id and reg-id
  this.options.params = this.options.params || {};
  this.options.regId = this.options.regId || 1;
  this.registrar = ua.configuration.registrarServer;
  this.expires = ua.configuration.registerExpires;

  // Contact header
  this.contact = ua.contact.toString();

  // Call-ID and CSeq values RFC3261 10.2
  this.call_id = SIP.Utils.createRandomToken(22);
  this.cseq = Math.floor(Math.random() * 10000);

  this.options.params.to_uri = this.options.params.to_uri || ua.configuration.uri;
  this.options.params.to_displayName = this.options.params.to_displayName || ua.configuration.displayName;
  this.options.params.call_id = this.options.params.call_id || this.call_id;
  this.options.params.cseq = this.options.params.cseq || this.cseq;

  // Extends ClientContext
  SIP.Utils.augment(this, SIP.ClientContext, [ua, 'REGISTER', this.registrar, this.options]);

  this.registrationTimer = null;
  this.registrationExpiredTimer = null;

  // Set status
  this.registered = false;

  this.logger = ua.getLogger('sip.registercontext');
  ua.on('transportCreated', function (transport) {
    transport.on('disconnected', this.onTransportDisconnected.bind(this));
  }.bind(this));
};

RegisterContext.prototype = Object.create({}, {
  register: {writable: true, value: function register (options = {}) {
    // Handle Options
    this.options = SIP.Utils.defaultOptions(this.options, options);
    const extraHeaders = (this.options.extraHeaders || []).slice();

    let contact = this.contact;
    contact += ';reg-id=' + this.options.regId; // TODO: No way to turn this off
    contact += ';+sip.instance="<urn:uuid:' + this.options.instanceId + '>"';

    if (this.options.extraContactHeaderParams) {
      this.options.extraContactHeaderParams.forEach((header) => {
        contact += ';' + header;
      });
    }

    extraHeaders.push('Contact: ' + contact + ';expires=' + this.expires);
    extraHeaders.push('Allow: ' + SIP.UA.C.ALLOWED_METHODS.toString());

    // Save original extraHeaders to be used in .close
    this.closeHeaders = this.options.closeWithHeaders ?
      (this.options.extraHeaders || []).slice() : [];

    this.receiveResponse = function(response) {
      var contact, expires,
        contacts = response.getHeaders('contact').length,
        cause;

      // Discard responses to older REGISTER/un-REGISTER requests.
      if(response.cseq !== this.cseq) {
        return;
      }

      // Clear registration timer
      if (this.registrationTimer !== null) {
        SIP.Timers.clearTimeout(this.registrationTimer);
        this.registrationTimer = null;
      }

      switch(true) {
        case /^1[0-9]{2}$/.test(response.status_code):
          this.emit('progress', response);
          break;
        case /^2[0-9]{2}$/.test(response.status_code):
          this.emit('accepted', response);

          if(response.hasHeader('expires')) {
            expires = response.getHeader('expires');
          }

          if (this.registrationExpiredTimer !== null) {
            SIP.Timers.clearTimeout(this.registrationExpiredTimer);
            this.registrationExpiredTimer = null;
          }

          // Search the Contact pointing to us and update the expires value accordingly.
          if (!contacts) {
            this.logger.warn('no Contact header in response to REGISTER, response ignored');
            break;
          }

          while(contacts--) {
            contact = response.parseHeader('contact', contacts);
            if(contact.uri.user === this.ua.contact.uri.user) {
              expires = contact.getParam('expires');
              break;
            } else {
              contact = null;
            }
          }

          if (!contact) {
            this.logger.warn('no Contact header pointing to us, response ignored');
            break;
          }

          if(!expires) {
            expires = this.expires;
          }

          // Re-Register before the expiration interval has elapsed.
          // For that, decrease the expires value. ie: 3 seconds
          this.registrationTimer = SIP.Timers.setTimeout(() => {
            this.registrationTimer = null;
            this.register(this.options);
          }, (expires * 1000) - 3000);
          this.registrationExpiredTimer = SIP.Timers.setTimeout(() => {
            this.logger.warn('registration expired');
            if (this.registered) {
              this.unregistered(null, SIP.C.causes.EXPIRES);
            }
          }, expires * 1000);

          //Save gruu values
          if (contact.hasParam('temp-gruu')) {
            this.ua.contact.temp_gruu = SIP.URI.parse(contact.getParam('temp-gruu').replace(/"/g,''));
          }
          if (contact.hasParam('pub-gruu')) {
            this.ua.contact.pub_gruu = SIP.URI.parse(contact.getParam('pub-gruu').replace(/"/g,''));
          }

          this.registered = true;
          this.emit('registered', response || null);
          break;
        // Interval too brief RFC3261 10.2.8
        case /^423$/.test(response.status_code):
          if(response.hasHeader('min-expires')) {
            // Increase our registration interval to the suggested minimum
            this.expires = response.getHeader('min-expires');
            // Attempt the registration again immediately
            this.register(this.options);
          } else { //This response MUST contain a Min-Expires header field
            this.logger.warn('423 response received for REGISTER without Min-Expires');
            this.registrationFailure(response, SIP.C.causes.SIP_FAILURE_CODE);
          }
          break;
        default:
          cause = SIP.Utils.sipErrorCause(response.status_code);
          this.registrationFailure(response, cause);
      }
    };

    this.onRequestTimeout = function() {
      this.registrationFailure(null, SIP.C.causes.REQUEST_TIMEOUT);
    };

    this.onTransportError = function() {
      this.registrationFailure(null, SIP.C.causes.CONNECTION_ERROR);
    };

    this.cseq++;
    this.request.cseq = this.cseq;
    this.request.setHeader('cseq', this.cseq + ' REGISTER');
    this.request.extraHeaders = extraHeaders;
    this.send();
  }},

  registrationFailure: {writable: true, value: function registrationFailure  (response, cause) {
    this.emit('failed', response || null, cause || null);
  }},

  onTransportDisconnected: {writable: true, value: function onTransportDisconnected () {
    this.registered_before = this.registered;
    if (this.registrationTimer !== null) {
      SIP.Timers.clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }

    if (this.registrationExpiredTimer !== null) {
      SIP.Timers.clearTimeout(this.registrationExpiredTimer);
      this.registrationExpiredTimer = null;
    }

    if(this.registered) {
      this.unregistered(null, SIP.C.causes.CONNECTION_ERROR);
    }
  }},

  onTransportConnected: {writable: true, value: function onTransportConnected () {
    this.register(this.options);
  }},

  close: {writable: true, value: function close () {
    var options = {
      all: false,
      extraHeaders: this.closeHeaders
    };

    this.registered_before = this.registered;
    if (this.registered) {
      this.unregister(options);
    }
  }},

  unregister: {writable: true, value: function unregister (options) {
    var extraHeaders;

    options = options || {};

    if(!this.registered && !options.all) {
      this.logger.warn('Already unregistered, but sending an unregister anyways.');
    }

    extraHeaders = (options.extraHeaders || []).slice();

    this.registered = false;

    // Clear the registration timer.
    if (this.registrationTimer !== null) {
      SIP.Timers.clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }

    if(options.all) {
      extraHeaders.push('Contact: *');
      extraHeaders.push('Expires: 0');
    } else {
      extraHeaders.push('Contact: '+ this.contact + ';expires=0');
    }


    this.receiveResponse = function(response) {
      var cause;

      switch(true) {
        case /^1[0-9]{2}$/.test(response.status_code):
          this.emit('progress', response);
          break;
        case /^2[0-9]{2}$/.test(response.status_code):
          this.emit('accepted', response);
          if (this.registrationExpiredTimer !== null) {
            SIP.Timers.clearTimeout(this.registrationExpiredTimer);
            this.registrationExpiredTimer = null;
          }
          this.unregistered(response);
          break;
        default:
          cause = SIP.Utils.sipErrorCause(response.status_code);
          this.unregistered(response,cause);
      }
    };

    this.onRequestTimeout = function() {
      // Not actually unregistered...
      //this.unregistered(null, SIP.C.causes.REQUEST_TIMEOUT);
    };

    this.cseq++;
    this.request.cseq = this.cseq;
    this.request.setHeader('cseq', this.cseq + ' REGISTER');
    this.request.extraHeaders = extraHeaders;

    this.send();
  }},

  unregistered: {writable: true, value: function unregistered (response, cause) {
    this.registered = false;
    this.emit('unregistered', response || null, cause || null);
  }}

});


SIP.RegisterContext = RegisterContext;
};
