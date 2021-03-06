var crypto = require('crypto');
var async = require('async');

var GitHub = require('./github').GitHub;
var config = require('./config');

exports.makeStrategyCallback = function (context) {
  var User = context.models.User;
  var logger = context.logger;

  // The GitHub API uses team IDs, but names are more convenient for configuration, and we can't
  // look them up until we have a user's token. Cache them globally here.
  var teamIds = {
    access: null,
    admin: null
  };

  // "Enumerated constants" used to mark authorization levels. ACCESS and ADMIN match the values
  // of access_level in Strider's User model.
  var UNAUTHORIZED = {};
  var ACCESS = 0;
  var ADMIN = 1;

  // Given a profile from the GitHub API, return an array of normalized email addresses to test.
  var emailsFromGitHub = function (gh, callback) {
    gh.emails(function (err, emails) {
      if (err) return callback(err);

      var primary = null;

      var verified = emails.filter(function (result) {
        return result.verified;
      });

      if (verified.length === 0) {
        return callback(new Error('You have no verified email addresses on GitHub.'))
      }

      var addresses = verified.map(function (result) {
        var downcased = result.email.toLowerCase();

        if (result.primary && !primary) {
          primary = downcased;
        }

        return downcased;
      });

      if (!primary) {
        primary = addresses[0];
      }

      logger.debug('Discovered ' + addresses.length + ' email addresses from the GitHub API.', {
        addresses: addresses,
        primary: primary
      });

      callback(null, addresses, primary);
    });
  };

  // Locate the single Strider User model that uses one of the potential email addresses from
  // GitHub. Create one if none are found.
  var findUser = function (gh, profile, callback) {
    emailsFromGitHub(gh, function (err, addresses, primary) {
      if (err) return callback(err);

      User.find({ email: { $in: addresses }}, function (err, results) {
        if (err) return callback(err);

        if (results.length > 1) {
          var emails = results.map(function (r) { return r.email });
          return callback(new Error('More than one user found matching addresses: ' + emails));
        }

        if (results.length === 0) {
          logger.info('Creating new user named ' + primary);

          var user = new User();
          user.email = primary;
          user.created = new Date();
          user.set('password', crypto.randomBytes(256).toString('utf-8'));
          user.projects = [];

          return user.save(function (err) {
            callback(err, user);
          });
        }

        logger.info('Existing user with address ' + results[0].email + ' authenticated.');
        callback(null, results[0]);
      });
    });
  };

  // Derive a user's current level of authorization against membership in a GitHub organization.
  // Organization owners correspond to Strider admins.
  var checkOrgMembership = function (gh, callback) {
    logger.debug('Checking authorization by membership in organization ' + config.orgName);

    gh.belongsToOrganization(config.orgName, function (err, isMember, isAdmin) {
      if (err) return callback(err);
      logger.debug('Is member: ' + isMember + ' Is admin: ' + isAdmin);

      if (isMember && isAdmin) return callback(null, ADMIN);
      if (isMember && !isAdmin) return callback(null, ACCESS);
      callback(null, UNAUTHORIZED);
    });
  };

  // Fetch the ID of a specific team (access or admin) from the GitHub API based on the name
  // provided by the corresponding environment variable, unless it has been fetched already or
  // the team name has not been provided.
  var ensureTeamId = function (gh, teamType, callback) {
    if (teamIds[teamType] !== null) {
      return callback();
    }

    var configKey = teamType + 'TeamName';
    var teamName = config[configKey];
    if (!teamName) {
      return callback();
    }

    gh.findTeamWithName(config.orgName, teamName, function (err, id) {
      if (err) return callback(err);

      if (id === null) {
        logger.debug('Unable to fetch team id for team named ' + teamName);
      } else {
        logger.debug('Team ' + teamType + ' named ' + teamName + ' has id ' + id);
        teamIds[teamType] = id;
      }

      callback();
    });
  };

  // Ensure that both access and admin teams have had their IDs fetched, if names were provided.
  var ensureTeamIds = function (gh, callback) {
    async.parallel([
      function (cb) { ensureTeamId(gh, 'access', cb); },
      function (cb) { ensureTeamId(gh, 'admin', cb); }
    ], callback);
  };

  // Derive a user's current level of authorization against membership in one of two teams withing
  // a GitHub organization.
  var checkTeamMembership = function (gh, callback) {
    logger.debug('Checking authorization by membership in teams');

    ensureTeamIds(gh, function (err) {
      if (err) return callback(err);

      // User doesn't belong to the org at all, and it's the first request.
      if (teamIds.access === null || teamIds.admin === null) {
        return callback(null, UNAUTHORIZED);
      }

      async.parallel({
        access: function (cb) { gh.belongsToTeam(teamIds.access, cb); },
        admin: function (cb) { gh.belongsToTeam(teamIds.admin, cb); }
      }, function (err, results) {
        if (err) return callback(err);
        logger.debug('Is member: ' + results.access + ' Is admin: ' + results.admin);

        if (results.admin) return callback(null, ADMIN);
        if (results.access) return callback(null, ACCESS);
        callback(null, UNAUTHORIZED);
      });
    });
  };

  // Derive a user's current level of authorization, choosing a source of truth appropriate to the
  // current configuration.
  var checkAuthorization = function (gh, callback) {
    if (config.accessTeamName && config.adminTeamName) {
      checkTeamMembership(gh, callback);
    } else {
      checkOrgMembership(gh, callback);
    }
  };

  // Update the Strider User model based on the authorizations derived from the GitHub API. Link
  // the user to the GitHub provider, as well.
  var syncUserModel = function (gh, user, authorization, callback) {
    if (!user || authorization === UNAUTHORIZED) {
      return callback();
    }

    user.account_level = authorization;

    var account = user.account('github', gh.profile.id);
    if (!account) {
      user.accounts.push({
        provider: 'github',
        id: gh.profile.id,
        display_url: gh.profile.profileUrl,
        title: gh.profile.username,
        config: {
          accessToken: gh.accessToken,
          login: gh.profile.username,
          email: user.email,
          gravatarId: gh.profile._json.gravatar_id,
          name: gh.profile.displayName
        },
        cache: []
      });
    }

    user.save(function (err) {
      callback(err, user);
    });
  };

  // All together, now.
  return function(accessToken, refreshToken, profile, callback) {
    var gh = new GitHub(profile, accessToken);

    async.parallel({
      user: async.apply(findUser, gh, profile),
      authorization: async.apply(checkAuthorization, gh)
    }, function (err, results) {
      if (err) return callback(err);
      if (results.authorization === UNAUTHORIZED) {
        return callback(new Error("User not authorized"));
      }

      syncUserModel(gh, results.user, results.authorization, callback);
    });
  };
};
