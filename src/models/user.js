import _ from 'lodash';
import bcrypt from 'bcrypt-as-promised';
import mongoose from 'mongoose';
import objectId from 'libs/objectId';
import errors from 'libs/errors';
import roles from 'libs/roles';
import utils from 'libs/utils';
import OAuthJaccount from 'oauth-jaccount';

export default () => {
  const UserSchema = new mongoose.Schema({
    userName: String,
    userName_std: String,
    isOAuthAccount: Boolean,
    role: String,
    hash: String,   // only for isOAuthAccount=false
    settings: {
      compiler: String,
      hideId: Boolean,
    },
    profile: {
      realName: String,
      studentId: String,
      displayName: String,
      teacher: String,
      initial: Boolean,
    },
    submissionNumber: Number,
    submission: {type: mongoose.Schema.Types.ObjectId, ref: 'Submission'},
    rating: {
      score: Number,
      win: Number,
      lose: Number,
      draw: Number,
    },
    match: {
      streak: Number,
      change: Number,
      priority: Number,
      initial: Boolean,
    },
  }, {
    timestamps: true,
  });

  // User Model
  let User;

  /**
   * Normalize the userName to form a userName_std
   * @param userName
   * @return {String}
   */
  UserSchema.statics.normalizeUserName = function(userName) {
    return String(userName).toLowerCase().trim();
  };

  /**
   * Return whether it is a valid userName
   * @param userName
   * @returns {boolean}
   */
  UserSchema.statics.isValidUserName = function(userName) {
    return userName && User.normalizeUserName(userName)[0] !== '_';
  };

  /**
   * Build userName for OAuth account
   * @param type  the OAuth type (eg. jaccount)
   * @param id    the unique id of this OAuth provider (eg. student id)
   * @return {String}
   */
  UserSchema.statics.buildOAuthUserName = function(type, id) {
    return `_${type}_${id}`;
  };

  /**
   * Get user object by userName
   * @return {User} Mongoose user object
   */
  UserSchema.statics.getUserObjectByUserNameAsync = async function(
    userName, throwWhenNotFound = true) {
    const userNameNormalized = User.normalizeUserName(userName);
    const user = await User.findOne({userName_std: userNameNormalized});
    if (user === null && throwWhenNotFound) {
      throw new errors.UserError('User not found');
    }
    return user;
  };

  /**
   * Get the user object by userId
   * @return {User} Mongoose user object
   */
  UserSchema.statics.getUserObjectByIdAsync = async function(
    id, throwWhenNotFound = true) {
    if (!objectId.isValid(id)) {
      if (throwWhenNotFound) {
        throw new Error(`User ${id} not valid`);
      } else {
        return null;
      }
    }
    const user = await User.findOne({_id: id});
    if (user === null && throwWhenNotFound) {
      throw new Error(`User ${id} not found`);
    }
    return user;
  };

  /**
   * Get all users, order by _id
   * @return {[User]}
   */
  UserSchema.statics.getAllUsersAsync = async function() {
    return await User.find().sort({_id: 1});
  };

  UserSchema.statics.getEffectiveUsersAsync = async function() {
    return await User.find({
      //'rating.score': {$gt: 0},
    }).sort({'rating.score': -1});
  };

  /**
   * Increase the submission counter of a user and return its new value
   *
   * @param  {MongoId} id User Id
   * @return {Number} Submission counter
   */
  UserSchema.statics.incAndGetSubmissionNumberAsync = async function(id) {
    if (!objectId.isValid(id)) {
      throw new errors.UserError('User not found');
    }
    const udoc = await User.findByIdAndUpdate(
      id,
      {$inc: {submissionNumber: 1}},
      {new: true, select: {submissionNumber: 1}},
    ).exec();
    return udoc.submissionNumber;
  };

  /**
   * Insert a new OAuth account
   * @return {User} Newly created user object
   */
  UserSchema.statics.createOAuthUserAsync = async function(
    {oauthName, realName, studentId, displayName}) {
    const userName = User.buildOAuthUserName(oauthName, studentId);
    if (await User.getUserObjectByUserNameAsync(userName, false) !== null) {
      throw new errors.UserError('Username already taken');
    }
    const newUser = new this({
      isOAuthAccount: true,
      role: 'student',
      profile: {
        realName,
        studentId,
        displayName,
        teacher: '',
        initial: true,
      },
      settings: {
        compiler: '',
        hideId: false,
      },
      rating: {
        score: 0,
        win: 0,
        lose: 0,
        draw: 0,
      },
      match: {
        streak: 0,
        change: 0,
        priority: 0,
        initial: true,
      },
      submissionNumber: 0,
    });
    newUser.setUserName(userName);
    try {
      await newUser.save();
    } catch (e) {
      if (e.name === 'MongoError' && e.code === 11000) {
        // duplicate key error
        throw new errors.UserError('Username already taken');
      } else {
        throw e;
      }
    }
    //newUser.rating = await DI.models.Rating.initUserRatingAsync(newUser);
    await newUser.save();
    return newUser;
  };

  /**
   * Insert a new non-OAuth account
   * @return {User} Newly created user object
   */
  UserSchema.statics.createNonOAuthUserAsync = async function({userName, password}) {
    if (await User.getUserObjectByUserNameAsync(userName, false) !== null) {
      throw new errors.UserError('Username already taken');
    }
    const newUser = new this({
      isOAuthAccount: false,
      role: 'student',
      profile: {
        realName: '',
        studentId: '',
        displayName: userName,
        teacher: '',
        initial: true,
      },
      settings: {
        compiler: '',
        hideId: false,
      },
      rating: {
        score: 0,
        win: 0,
        lose: 0,
        draw: 0,
      },
      match: {
        streak: 0,
        change: 0,
        priority: 0,
        initial: true,
      },
      submissionNumber: 0,
    });
    newUser.setUserName(userName);
    await newUser.setPasswordAsync(password);
    try {
      await newUser.save();
    } catch (e) {
      if (e.name === 'MongoError' && e.code === 11000) {
        // duplicate key error
        throw new errors.UserError('Username already taken');
      } else {
        throw e;
      }
    }
    return newUser;
  };

  /**
   * Retrive an user object and verify its credential
   * @return {User} The user object if password matches
   */
  UserSchema.statics.authenticateAsync = async function(userName, password) {
    const user = await User.getUserObjectByUserNameAsync(userName);
    const match = await user.testPasswordAsync(password);
    if (!match) {
      throw new errors.UserError('Incorrect username or password');
    }
    return user;
  };

  /**
   * SJTU Jaccount login with node-oauth-jaccount
   * @param code
   * @returns {Promise<*>}
   */
  UserSchema.statics.authenticateJaccountAsync = async function(code) {
    const jaccount = new OAuthJaccount(DI.config.jaccount);
    const oauthName = 'jaccount';

    const redirect_url = utils.url('/oauth/jaccount/redirect', true);
    const resp = await jaccount.getToken(code, redirect_url);
    if (resp.e) {
      throw new errors.UserError(`Error: ${resp.e}. Please sign in again.`);
    }

    const profile = (await jaccount.getProfile(resp.access_token)).entities[0];
    const studentId = profile.code;
    const userName = User.buildOAuthUserName(oauthName, studentId);

    const user = await User.getUserObjectByUserNameAsync(userName, false);
    if (user === null) {
      const realName = profile.name;
      const displayName = profile.account;
      return await User.createOAuthUserAsync(
        {oauthName, realName, studentId, displayName});
    }

    return user;
  };

  /**
   * For debug purpose only.
   */
  UserSchema.statics.authenticateFakeOAuthAsync = async function(studentId) {
    if (DI.config.oauthDebug !== true) {
      throw new errors.PermissionError();
    }
    const oauthName = 'fake';
    const userName = User.buildOAuthUserName(oauthName, studentId);
    const user = await User.getUserObjectByUserNameAsync(userName, false);
    if (user === null) {
      // not signed in before. create a new account
      // realname API is not working anymore :(
      return await User.createOAuthUserAsync(
        {oauthName, realName: '', studentId, displayName: studentId});
    }
    return user;
  };

  /**
   * Update the profile of a user
   * @return {User} The new user object
   */
  UserSchema.statics.updateProfileAsync = async function(userId, profile) {
    if (profile !== Object(profile)) {
      throw new Error('Parameter `profile` should be an object');
    }
    const user = await User.getUserObjectByIdAsync(userId);
    user.profile = {
      ...profile,
      initial: false,
    };
    if (user.profile.displayName) {
      user.profile.displayName = user.profile.displayName.substr(0, 100);
    }
    await user.save();
    await DI.eventBus.emitAsyncWithProfiling('user.profile:updated');
    return user;
  };

  /**
   * Check whether a user has some permissions
   * @return {Boolean}
   */
  UserSchema.methods.hasPermission = function(perm) {
    if (this.role === undefined) {
      return false;
    }
    if (roles[this.role] === undefined) {
      return false;
    }
    return (roles[this.role] & perm) !== 0;
  };

  /**
   * Set the userName and userName_std
   */
  UserSchema.methods.setUserName = function(userName) {
    this.userName = userName;
    this.userName_std = UserSchema.statics.normalizeUserName(userName);
  };

  /**
   * Set the password hash
   */
  UserSchema.methods.setPasswordAsync = async function(plain) {
    this.hash = await bcrypt.hash(plain, 10);
  };

  /**
   * Test whether a password matches the hash
   */
  UserSchema.methods.testPasswordAsync = async function(password) {
    try {
      await bcrypt.compare(password, this.hash);
    } catch (e) {
      if (e instanceof bcrypt.MISMATCH_ERROR) {
        return false;
      } else {
        throw e;
      }
    }
    return true;
  };

  UserSchema.statics.updateRatingAsync = async function(uid, rdoc) {
    const user = await User.getUserObjectByIdAsync(uid);
    user.rating.score = rdoc.after;
    if (rdoc.status === DI.models.Rating.STATUS_WIN) {
      if (user.match.streak > 0) {
        user.match.streak++;
        user.match.change += rdoc.change;
      } else {
        user.match.streak = 1;
        user.match.change = rdoc.change;
      }
      user.rating.win++;
    } else if (rdoc.status === DI.models.Rating.STATUS_LOSE) {
      if (user.match.streak < 0) {
        user.match.streak--;
        user.match.change += rdoc.change;
      } else {
        user.match.streak = -1;
        user.match.change = rdoc.change;
      }
      user.rating.lose++;
    } else if (rdoc.status === DI.models.Rating.STATUS_DRAW) {
      user.match.streak = 0;
      user.match.change = 0;
      user.rating.draw++;
    }
    user.match.priority = Math.abs(user.match.streak * user.match.change) + 1;
    await user.save();
    return user;
  };

  /**
   * if sdoc is set, it is a new submission
   * @param uid
   * @param sdoc
   * @returns {Promise<void>}
   */
  UserSchema.statics.setMatchPriorityInitialAsync = async function(
    uid, sdoc = null) {
    const user = await User.getUserObjectByIdAsync(uid);
    if (sdoc) {
      user.match.priority = Math.abs(user.match.streak * user.match.change) + 1;
      user.match.initial = true;
      user.submission = sdoc;
    } else {
      user.match.initial = false;
    }
    await user.save();
  };

  UserSchema.methods.isBusy = function() {
    return this.match.priority <= 0;
  };

  UserSchema.methods.setBusyAsync = async function() {
    this.match.priority = 0;
    await this.save();
  };

  UserSchema.statics.getHighestPriority = function() {
    return User.find({
      'match.priority': {$gt: 0},
    }).sort({
      'match.initial': -1,
      'match.priority': -1,
    });
  };

  UserSchema.statics.getWinCount = async function(u1, u2) {
    const mdocs = await DI.models.Match.getMatchesBetweenSubmissions(
      u1.submission, u2.submission);
    let u1win = 0, u2win = 0, draw = 0, syserror = false;
    const first = _.first(mdocs);
    if (first && first.status === DI.models.Match.STATUS_SYSTEM_ERROR) {
      const d1 = new Date(first.updatedAt);
      const d2 = new Date();
      const diff = parseInt(d2 - d1);
      // if (diff < 1) {
      if (diff < 86400000) {
        syserror = true;
        return [u1win, u2win, draw, syserror];
      }
    }
    _.forEach(mdocs, mdoc => {
      if (mdoc.status === DI.models.Match.STATUS_U1WIN) {
        mdoc.u1Submission === u1.submission ? ++u1win : ++u2win;
      } else if (mdoc.status === DI.models.Match.STATUS_U2WIN) {
        mdoc.u1Submission === u1.submission ? ++u2win : ++u1win;
      } else if (mdoc.status === DI.models.Match.STATUS_DRAW) {
        ++draw;
      }
    });
    return [u1win, u2win, draw, syserror];
  };

  UserSchema.statics.getBestOpponentAsync = async function(u1) {
    // The default version of mongodb on Ubuntu is 2.6
    // So we may use some naive code to avoid version problems
    let score_limit = {$gte: u1.rating.score - 100};
    if (!u1.match.initial && u1.match.streak < 0) {
      score_limit['$lte'] = u1.rating.score + 100;
    }
    let udocs = await User.aggregate().match({
      'match.priority': {$gt: 0},
      '_id': {$ne: u1._id},
      'rating.score': score_limit,
    }).project({
      delta: {
        $cond: {
          if: {
            $gte: ['$rating.score', u1.rating.score],
          }, then: {
            $subtract: ['$rating.score', u1.rating.score],
          }, else: {
            $subtract: [u1.rating.score, '$rating.score'],
          },
        },
      },
      submission: true,
      rating: true,
    }).sort({
      delta: 1,
    }).allowDiskUse(true).exec();

    for (let i = 0; i < udocs.length; i++) {
      const u2 = udocs[i];
      let [u1win, u2win, draw, syserror] = await User.getWinCount(u1, u2);
      if (syserror) continue;
      if (u1win === u2win) {
        const f1 = DI.models.Rating.getTitleData(u1.rating.score).factor;
        const f2 = DI.models.Rating.getTitleData(u2.rating.score).factor;
        if (draw >= 1 && u2.delta <= f1 + f2) {
          continue;
        }
      } else if (u1win - u2win >= 1 && u1.rating.score >= u2.rating.score) {
        continue;
      } else if (u2win - u1win >= 1 && u2.rating.score >= u1.rating.score) {
        continue;
      }
      return await User.getUserObjectByIdAsync(u2._id);
    }

    return null;
  };

  UserSchema.statics.getExceptionUserAsync = async function() {
    return await User.find({
      'match.priority': {$lte: 0},
      //'submission': {$ne: null},
    }).exec();
  };

  UserSchema.methods.resetExceptionAsync = async function() {
    const sdoc = await DI.models.Submission.getLastSubmissionByUserAsync(
      this._id);
    if (sdoc) {
      this.match.priority = Math.abs(this.match.streak * this.match.change) + 1;
    } else {
      this.match.priority = 0;
    }
    await this.save();
  };

  UserSchema.index({userName_std: 1}, {unique: true});

  User = mongoose.model('User', UserSchema);
  return User;

};
