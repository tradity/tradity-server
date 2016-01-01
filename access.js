"use strict";

/**
 * Provides the {@link module:access~Access} object.
 * 
 * @public
 * @module access
 */

/**
 * Represents the access levels in which server code gets executed.
 * 
 * Access levels are identified by simple strings, but #242 is
 * basically about throwing them all out and introducing new ones.
 * After that, there should be a list of the new levels with
 * associated documentation.
 * 
 * @public
 * @constructor module:access~Access
 */
class Access {
  constructor() {
    this.areas = [];
    this.hasAnyAccess = false;
    
    // above code is equiv to this.dropAll();
  }
    
  /**
   * Returns a copy of this access object.
   * 
   * @return {module:access~Access}  An access object with identical access levels.
   * 
   * @function module:access~Access#clone
   */
  clone() {
    const a = new Access();
    a.areas = this.areas.slice();
    a.hasAnyAccess = this.hasAnyAccess;
    return a;
  }
  
  toString() { return this.toJSON(); }

  /**
   * Serializes the access levels associated with this access object
   * into a JSON string that can be passed to {@link module:access~Access.fromJSON}.
   * 
   * @return {string}  A short machine-readable description of the access
   *                   levels associated with this access object.
   * 
   * @function module:access~Access#toJSON
   */
  toJSON() {
    if (this.hasAnyAccess) {
      return '["*"]';
    }
    
    return JSON.stringify(this.areas);
  }

  /**
   * Serializes the access levels associated with this access object
   * into an array of access levels.
   * 
   * @return {string[]}  A list of the access levels associated with
   *                     this access object, possibly including <code>"*"</code>.
   * 
   * @function module:access~Access#toJSON
   */
  toArray() {
    if (this.hasAnyAccess) {
      return ['*'];
    }
    
    return this.areas;
  }

  /**
   * Checks for privileges to a certain access level.
   * 
   * @param {string} area  The access level identifier.
   * 
   * @return {boolean}  Indicates whether access is present.
   * 
   * @function module:access~Access#has
   */
  has(area) {
    return this.hasAnyAccess || (this.areas.indexOf(area) !== -1);
  }

  /**
   * Grants all access levels held by another access object.
   * 
   * @param {module:access~Access} otherAccess  Another access object.
   * 
   * @function module:access~Access#update
   */
  update(otherAccess) {
    if (otherAccess.hasAnyAccess) {
      this.grant('*');
    }
    
    for (let i = 0; i < otherAccess.areas.length; ++i) {
      this.grant(otherAccess.areas[i]);
    }
  }

  /**
   * Grants access to a specified access level.
   * 
   * @param {string} area  The access level to grant access to, or
   *                       <code>"*"</code> to indicate full access.
   * 
   * @function module:access~Access#grant
   */
  grant(area) {
    area = area.trim();
    if (!area) {
      return;
    }
    
    if (area === '*') {
      return this.grantAny();
    }
    
    if (this.areas.indexOf(area) === -1) {
      this.areas.push(area);
    }
  }

  /**
   * Grants full access to all access levels.
   * 
   * @function module:access~Access#grantAny
   */
  grantAny() {
    this.hasAnyAccess = true;
  }

  /**
   * Removes access to a specified access level.
   * 
   * @param {string} area  The access level to remove access from, or
   *                       <code>"*"</code> to indicate removing full access.
   * 
   * @function module:access~Access#drop
   */
  drop(area) {
    area = area.trim();
    if (!area) {
      return;
    }
    
    if (area === '*') {
      return this.dropAny();
    }
    
    let index;
    while ((index = this.areas.indexOf(area)) !== -1) {
      this.areas.splice(index, 1);
    }
  }

  /**
   * Drop full access, if previously held.
   * Access levels that have been granted explicitly
   * are not affected.
   * 
   * @function module:access~Access#dropAny
   */
  dropAny() {
    this.hasAnyAccess = false;
  }

  /**
   * Drop all access levels held by this objects,
   * possibly including full access.
   * 
   * @function module:access~Access#dropAall
   */
  dropAll() {
    this.dropAny();
    this.areas = [];
  }
}

/**
 * Creates a new access object from a JSON specification.
 * See also {@link module:access~Access#toJSON}.
 * 
 * @param {string} j  A string describing the access levels.
 * 
 * @return {module:access~Access}  An access object with the access levels
 *                                 speicified in <code>j</code>.
 * 
 * @function module:access~Access.fromJSON
 */
Access.fromJSON = function(j) {
  const a = new Access();
  if (!j) {
    return a;
  }
    
  if (j.trim() === '*') {
    a.grant('*');
  } else {
    const p = JSON.parse(j);
    
    // note that this can handle both an array and the "*" string!
    for (let i = 0; i < p.length; ++i) {
      a.grant(p[i]);
    }
  }
  
  return a;
};

exports.Access = Access;
