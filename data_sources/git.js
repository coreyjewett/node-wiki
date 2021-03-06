/***
 * @TODO: This file is completely a mindfuck. I need to rewrite it when we hit
 * v0.1.0
 */
var git = require('gitteh')
    path = require('path'),
    fs = require('fs'),
    logger = require('wiki/util/logging'),

    git_directory_attr = 16384,
    default_source_settings = {
        branch: 'master',
        create_repos: true,
        insert_initial_data: true,
        bare_repo: true
    }

function get_default_source_settings(settings) {
    var local_settings = settings.source || default_source_settings

    local_settings.root = path.join('.', settings.hostname + '.git')
    local_settings.author = settings.author || {}
    local_settings.home_template = local_settings.home_template || 'templates/Home.md'

    return local_settings
}

function get_commit_author_data (settings) {
    var commit_data = {}

    commit_data.name = settings.source.author.name || 'Anonymous'
    commit_data.email = settings.source.author.email || settings.author_name + '@' + settings.hostname
    commit_data.time = new Date()

    return commit_data
}

function get_initial_template (filename, callback) {
    // First, verify that our file exists.
    fs.realpath(filename, function (err, filename) {
        if (err) throw err

        fs.readFile(filename, function get_template_file_contents(err, file_contents) {
            if (err) throw err

            callback(file_contents)
        })
    })
}

function get_ref_location(settings) {
    return path.join('refs', 'heads', settings.source.branch)
}

/**
 * This is a sort of confusing piece. I should probably abstract it out
 * a bit, but basically we are looking for the `home_template`, getting
 * it's contents, and then copying them into the git repository for our
 * first commit.
 *
 * @TODO: The "home_template" mechanism is just limiting. We should just
 * get every file out of a specific directory and copy them over to the
 * repository one-by-one.
 */
function insert_initial_data (callback, repo, settings) {
    var new_commit = repo.createCommit(),
        author_info = get_commit_author_data(settings),
        local_tree = repo.createTree(),
        blob = repo.createRawObject()

    new_commit.author = new_commit.committer = author_info
    new_commit.message = 'Initial data.'

    get_initial_template(settings.source.home_template, function (content) {
        var separator_index = settings.source.home_template.lastIndexOf('/'),
            blob_filename = settings.source.home_template.slice(separator_index + 1)

        blob.data = new Buffer(content)
        blob.type = 'blob'
        blob.save()

        local_tree.addEntry(blob.id, blob_filename, 33188)
        local_tree.save(function check_tree_saved (err, status) {
            if (err) throw err

            new_commit.setTree(local_tree)
            new_commit.save(function check_commit_saved (err, status) {
                if (err) throw err

                // Since our commit was successful, relate it to our branch.
                repo.createOidReference(get_ref_location(settings), new_commit.id, function (err, ref) {
                    if (err) throw err

                    logger.log(logger.levels.INFO,
                                settings,
                                'Initial data inserted for ' +
                                settings.source.root)

                    // Finally, let's finally read that file.
                    callback(repo, settings)
                })
            })
        })
    })
}

function create_repository (callback, settings) {
    git.initRepository(settings.source.root, true, function (err, repo) {
        if (err) throw err

        logger.log(logger.levels.INFO,
                    settings,
                    'Created new repository: ' +
                    settings.source.root)

        // Finally, let's read that file.
        callback(repo)
    })
}

/**
 * This function is called upon succesfully opening a repository in
 * order for us to ensure that our reference (aka branch) exists within
 * the repository. If it does not exist, then this will go ahead and
 * call insert_initial_data to insert any initial data required for this
 * branch.
 */
function check_references (callback, repo, settings)
{
    repo.listReferences(git.GIT_REF_LISTALL, function (err, refs) {
        if (err) throw err

        ref_list = refs.filter(function (ref_name) {
            if (ref_name === get_ref_location(settings)) return true
            return false
        })

        // If our ref_list is empty, then we don't have a ref to use.
        if (ref_list.length === 0)
            insert_initial_data(callback, repo, settings)

        // 
        else
            callback()
    })
}

/**
 * Open our git repository. If it does not exist and we want git repositories
 * to be created automatically, then have it created. If it exists, then
 * begin our search.
 */
function open_repository (callback, settings) {
    git.openRepository(settings.source.root, function repo_opened(err, _repo) {
        if (err) {
            if (!settings.source.create_repos || settings.attempted_create_repository)
            {
                throw err
            }
            else
            {
                create_repository(function init_repository (repo) {
                    check_references(callback, repo, settings)
                }, settings)

                return
            }
        }

        repo = _repo

        callback(repo, settings)
    })
}

/**
 * This is the part of the searching system that iterates recursively
 * through the tree until we've found our search item.
 */
function iterate_tree (callback, repo, tree, conf, search_list) {
    conf = conf || {}

    // We can override how matches are made with a custom validator
    conf.validator = conf.validator || function def_validator (possibility, search_list) {
        if (possibility == search_list[0])
            return true

        return false
    }

    for (var i=0; i < tree.entryCount; i++)
    {
        /**
         * We've used a callback factory here in order to prevent any
         * collisions in other searches that might be happening in
         * serial with this one. The factory provides a closure that
         * we can use to separate the global search list from this,
         * one and therefore every iteration will only work on it's
         * proper search list.
         */

        tree.getEntry(i, (function get_entry_factory (search_list) {
            return function get_entry (err, entry) {
                if (err) throw err
                if (search_list.length < 1) return

                // First, check if this entry is relevant.
                if (conf.validator(entry.filename, search_list))
                {
                    search_list.shift()

                    // Now, specific logic for trees or files.
                    if (entry.attributes == git_directory_attr && search_list.length > 0)
                    {
                        repo.getTree(entry.id, function get_next_tree(err, tree) {
                            if (err) throw err

                            iterate_tree(callback, repo, tree, conf, search_list)
                        })
                    }
                    else if (entry.attributes != git_directory_attr && search_list.length === 0)
                    {
                        callback(repo, entry, search_list.length)
                    }
                }
            }

        })(search_list))
    }
}

/**
 * Does some work with initializing our settings object for git.
 */
function setup_settings (_settings) {
    settings = _settings || {}

    settings.source = settings.source || get_default_source_settings(settings)

    return settings
}

module.exports = {
    find: function find_file(callback, search_path, _settings) {
        var path_separator = path.join('a', 'b')[1], // Please add this to node, Ryah ;)
            attempted_create_repository = false,
            attempted_create_branch = false,
            settings = setup_settings(_settings),
            repo, ref_list

        /**
         * Once the tree has been iterated and we have found the proper entry,
         * this will be used to convert the filename into our final output for
         * the passing to the callback provided to find_file.
         */
        function handle_matching_entry (repo, entry)
        {
            if (entry.attributes == git_directory_attr)
            {
                throw 'Currently, finding directories is not supported with git.'
            }
            else
            {
                var extension_index = entry.filename.lastIndexOf('.'),
                    file_basename = entry.filename.slice(0, extension_index),
                    file_extension = entry.filename.slice(extension_index+1)

                repo.getRawObject(entry.id, function (err, raw_object) {
                    if (err) throw err

                    // Finally... Success.
                    callback(0, [
                        raw_object.data.toString('utf-8'),
                        file_extension
                    ])
                })
            }
        }

        /**
         * Once a repository has been succesfully verified, this goes ahead and
         * finds the requested file within our repository - or throws an error
         * if the file does not exist.
         */
        function search_repository (repo, settings) {
            // Get our reference to the requested branch
            repo.getReference(get_ref_location(settings), function reference_getter (err, ref) {
                if (err) throw err

                // Next get the target commit for the requested branch
                repo.getCommit(ref.target, function target_getter (err, target) {
                  if (err) throw err

                    // Next, get this commit's tree
                    target.getTree(function tree_getter(err, tree) {
                        if (err) throw err

                        /**
                         * Iterate through the tree using a custom validator
                         * that provides us the ability to match filenames that
                         * don't have their extensions provided.
                         */
                        iterate_tree(handle_matching_entry, repo, tree, {
                            validator: function validate_filename (possibility, search_list) {
                                // All exact matches are matches.
                                if (possibility == search_list[0])
                                    return true

                                // Anything that starts with the expected value matches.
                                if (search_list.length === 1
                                    && possibility.indexOf(search_list[0] + '.') === 0)
                                {
                                    return true
                                }

                                return false
                            }
                        }, search_path.split(path_separator))
                    })
                })
            })
        }

        open_repository(search_repository, settings)
    },

    update: function update_file (callback, filename, _settings) {
        var path_separator = path.join('a', 'b')[1], // Please add this to node, Ryah ;)
            settings = setup_settings(_settings)

        function search_repository (repo, settings) {
            repo.getReference(get_ref_location(settings), function reference_getter (err, ref) {
                if (err) throw err

                repo.getCommit(ref.target, function target_getter (err, target) {
                    if (err) throw err

                    target.getTree(function tree_getter (err, tree) {
                        if (err) throw err

                        iterate_tree(handle_matching_entry, repo, tree, filename.split(path_separator))
                    })
                })
            })
        }

        open_repository(search_repository, settings)
    },

    delete: function delete_file (callback, filename, _settings) {
        var path_separator = path.join('a', 'b')[1], // Please add this to node, Ryah ;)
            settings = setup_settings(_settings)
    },

    get: function get_file(callback, filename, _settings) {
        this.find(callback, filename, _settings)
    }
}
